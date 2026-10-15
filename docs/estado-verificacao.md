# Evidências da entrega 0.1.0

15/10/2026. Estado de desenvolvimento, sem publicação de site.

## Concluído nesta máquina

- Implementados frontend React/TypeScript, gateway de login/logout e SQL incremental de proteção de sessões.
- `npm ci` com lockfile e cache gravável, sem mudança de versões, e `npm run build` concluídos.
- 20 testes SQL de identidade/RBAC passaram em PostgreSQL local PGlite.
- 12 testes SQL adicionais de gateway/sessões passaram; incluem JWT sem aprovação, expiração absoluta, sessão revogada, bloqueio e limites por usuário.
- 14 testes Node do gateway passaram com HTTP/Auth simulados.
- 9 cenários de navegador foram aprovados em Chromium usando respostas sintéticas: login desktop/mobile, erro genérico, administração, Diretor/mensagens, navegação de cobradora/RH, logout, falha de revogação remota e resposta tardia após logout. Uma falha inicial de seletor ambíguo do teste foi corrigida e o cenário afetado passou; não foi tratada como bug da aplicação. Nenhuma credencial real foi usada.
- Auditoria npm das dependências runtime retornou zero vulnerabilidades conhecidas na consulta realizada. Isso não prova ausência de falhas da aplicação.
- Originais do ZIP V75 comparados por hash de cada entrada e preservados sem alterações.
- `.env.local`, node_modules, dist, logs e resultados estão ignorados pelo Git. Somente parâmetros públicos na configuração local; nenhuma senha do usuário recebida.

## Evidências informadas pelo usuário

O usuário executou001 no SQL Editor e mostrou resultado sem erro. Criou conta Auth e executou bootstrap; captura mostrou GrazielePinheiro/Graziele/gerente_geral/enabled=true. Esses são resultados reportados e visíveis na captura; não equivalem a uma inspeção remota feita por este agente.

## Ainda pendente

- Usuário enviou captura com “Success. No rows returned” após executar migration003. Execução sem erro informada; falta verificar integração remota, publicar auth-gateway, configurar origem HTTPS exata e testar login com a conta real sem enviar a senha ao agente.
- Configurar Cloudflare Pages e publicar frontend na conta da empresa. O código foi enviado ao repositório gammaadm03-netizen/central-de-cobran-a, branch main, como alternativa ao download indisponível no chat. Não houve deploy remoto do site.
- O teste de conexão a Supabase pela máquina recebeu bloqueio de proxy403. URL/chave pública estão no draft, mas propagação/aplicação da configuração não foi confirmada.
- Login por usuário e administração descritos são implementação local verificada com mocks. Não foi demonstrado login remoto, entrega de e-mail, migração da posição atual ou persistência após novo deploy remoto.
- Troca/redefinição de senha pela aplicação, cadastro completo Auth, módulos financeiros, importações, cálculos, backups/restauração e migração da V75 permanecem pendentes. O primeiro endereço publicado será de homologação, sem uso operacional financeiro nesta versão.
- Verificar plano gratuito/cotas/pausas/retencão no provedor. Nenhum recurso pago habilitado.

Não declarar a Central completa, pronta para produção ou acessível por URL pública com base nesses testes locais.

## Entrega pelo GitHub

Primeiro envio do código confirmado pelo Git em 15/10/2026. A Cloudflare pode importar a branch main diretamente; downloads de ZIP pelo chat não são necessários. Configurar build e variáveis públicas antes do deploy. Nenhuma senha, UUID administrativo real ou base V75 foi versionada.
