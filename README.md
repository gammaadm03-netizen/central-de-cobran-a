# Central Financeira — Grupo Ecoplast

Versão de desenvolvimento **0.3.0**. Acesso, Painel, Caixa e primeira operação de Contas a Pagar na base central. **Não é a versão financeira completa nem uma publicação de produção.**

## O que funciona nesta entrega

React + TypeScript; login por usuário via gateway no Supabase; recuperação de senha por email com tela própria; permissões consultadas no banco; sessão em memória; logout e revogação de acesso; administração de perfis já existentes no Auth; associação configurável de cobradoras; auditoria das alterações implementadas; quadro de mensagens da Diretoria/Gerência com conclusão/reabertura. As alterações passam por RPCs e RLS, inclusive quando a interface é contornada.

O Painel recupera a organização da V75 e a marca original: período Hoje/Semana/Mês, movimento financeiro, alertas e Resumo da Diretoria. Os valores disponíveis vêm do banco; fontes ainda não migradas ficam explicitamente pendentes. Caixa inclui as onze contas oficiais, saldos manuais auditados e estoque de contingência. CP possui importação completa atômica, classificação obrigatória, preservação de baixas, filtros, paginação e CSV. O servidor analisa os arquivos e revalida permissões; o navegador não pode gravar lançamentos derivados por conta própria.

CR, Cobrança/validações, Faturamento, Margens, Comissões e RH ainda precisam ser portados. Também permanecem pendentes as previsões de CP, os relatórios Excel detalhados de CP, a migração da posição atual, backups operacionais, criação completa de contas Auth, redefinição administrativa e troca obrigatória. Não há números inventados nem bases V75 embutidas nos assets públicos. Leia o escopo e a ativação em [docs/ativacao-financeira.md](docs/ativacao-financeira.md).

## Desenvolvimento

Requisitos: Node 24, npm 11. Não é necessário criar worktree; cada tarefa cloud já é isolada.

```sh
npm ci --cache /workspace/onboarding-tools/npm-cache --no-audit --no-fund
```

A conexão pública deste projeto está em `config/supabase.public.json`: URL e chave **publishable**, que não são segredos. Assim, o build do GitHub funciona mesmo sem `.env.local`. Para usar outro projeto, as variáveis públicas da `.env.example` podem substituir esses valores. O Vite expõe somente essas duas configurações e rejeita chaves privadas antes de gerar o site. Chaves administrativas, senhas e tokens de provedor não pertencem ao frontend.

```sh
npm run dev
npm run build
```

Sem Edge Function publicada, o login retorna indisponibilidade; não existe login de demonstração, senha padrão ou bypass offline. Tokens ficam na memória da aba. Ao recarregar ou fechar a aba é necessário entrar novamente. Dados oficiais não usam localStorage. A sessão da aplicação tem limite absoluto de 12 horas; o perfil é revalidado pelo banco em cada operação.

## Banco e autenticação

Leia [supabase/README.md](supabase/README.md). O projeto atual já recebeu as migrations 001/003/004 manualmente. Para 0.3.0, aplicar uma única vez `supabase/dashboard/ativar-financeiro.sql`, que reúne 005/006/007 atomicamente, e publicar a nova função `payables-import`. Não repetir migrations já aplicadas. A função de login existente permanece independente. Deploy do site não atualiza automaticamente funções ou banco.

A conta inicial de Gerente deve existir no Auth e ter perfil oficial ativo. O código não contém UUID administrativo, contas reais, senhas, hashes ou dados financeiros. Nenhum comando de deploy recria o banco. Nunca execute reset contra o banco operacional.

## Verificação

```sh
npm test
npm run test:sql
npm run test:auth-sql
npm run test:payables-sql
npm run test:treasury-sql
npm run test:director-sql
npm run bundle:payables-gateway
npm run build
npm run test:browser
```

Os testes SQL executam PostgreSQL via PGlite com Auth simulado; os testes do gateway simulam serviços HTTP; o navegador usa respostas sintéticas e não acessa o Supabase real. A configuração de browser deste ambiente usa Chromium em `/usr/bin/chromium`; ajuste `CHROMIUM_PATH` em outra máquina. Uma suíte local aprovada não comprova autenticação remota ou publicação.

## Hospedagem

Frontend estático na Cloudflare Pages e banco/Auth/serviços no Supabase. Deploy separado do banco, seguindo [docs/publicacao.md](docs/publicacao.md) e [ativação financeira](docs/ativacao-financeira.md). O acesso não depende de PC ou túnel na empresa. A origem local fornece relatórios completos para importação; a posição real anterior ainda precisa ser migrada do estado operacional, sem substituir históricos por dados embutidos antigos.

Planos gratuitos precisam ser confirmados no painel quanto a cotas, pausas, retenção e disponibilidade. Nenhum recurso pago foi habilitado. Este repositório não contém autorização ou credenciais para publicar na conta de um provedor.
