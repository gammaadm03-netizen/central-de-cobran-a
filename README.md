# Central Financeira — Grupo Ecoplast

Versão de desenvolvimento **0.2.1**. Fundação de autenticação, autorização e administração para migração da V75. **Não é a versão financeira completa nem uma publicação de produção.**

## O que funciona nesta entrega

React + TypeScript; login por usuário via gateway no Supabase; recuperação de senha por email com tela própria; permissões consultadas no banco; sessão em memória; logout e revogação de acesso; administração de perfis já existentes no Auth; associação configurável de cobradoras; auditoria das alterações implementadas; quadro de mensagens da Diretoria/Gerência com conclusão/reabertura. As alterações passam por RPCs e RLS, inclusive quando a interface é contornada.

Os dez módulos financeiros aparecem somente aos perfis autorizados, com estado explícito de implantação. Não há números inventados nem bases V75 entregues ao navegador. Importações, títulos, validações financeiras, cálculos, RH, exportações, backups operacionais e migração ainda precisam de implementação/homologação. Criação de contas Auth, redefinição por administrador e troca obrigatória ainda não estão disponíveis na aplicação. A recuperação individual depende da configuração de URLs e do envio de email pelo Supabase.

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

Leia [supabase/README.md](supabase/README.md). O projeto atual já recebeu as migrations001 e003 manualmente. Para atualizar para0.2.0, aplique somente a migration004 após revisão e atualize a Edge Function. A mudança acrescenta recuperação auditada de senha sem apagar perfis ou outros registros. Configure as URLs de retorno no Auth antes de solicitar o email; publicar o site sozinho não envia instruções de recuperação.

A conta inicial de Gerente deve existir no Auth e ter perfil oficial ativo. O código não contém UUID administrativo, contas reais, senhas, hashes ou dados financeiros. Nenhum comando de deploy recria o banco. Nunca execute reset contra o banco operacional.

## Verificação

```sh
npm test
npm run test:sql
npm run test:auth-sql
npm run build
npm run test:browser
```

Os testes SQL executam PostgreSQL via PGlite com Auth simulado; os testes do gateway simulam serviços HTTP; o navegador usa respostas sintéticas e não acessa o Supabase real. A configuração de browser deste ambiente usa Chromium em `/usr/bin/chromium`; ajuste `CHROMIUM_PATH` em outra máquina. Uma suíte local aprovada não comprova autenticação remota ou publicação.

## Hospedagem

Frontend estático destinado a Cloudflare Pages e banco/Auth/gateway a Supabase. Deploy separado do banco, seguindo [docs/publicacao.md](docs/publicacao.md). O acesso final não depende de PC ou túnel na empresa. A base local enviará relatórios ao módulo de importação quando implementado; a posição real precisa ser migrada do estado operacional, sem substituir históricos por dados embutidos antigos.

Planos gratuitos precisam ser confirmados no painel quanto a cotas, pausas, retenção e disponibilidade. Nenhum recurso pago foi habilitado. Este repositório não contém autorização ou credenciais para publicar na conta de um provedor.
