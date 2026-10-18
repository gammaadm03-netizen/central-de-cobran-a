# Central Financeira — Grupo Ecoplast

Versão de desenvolvimento **0.7.0**. Painel, Caixa/Bancos, Contas a Pagar, Contas a Receber e Cobrança utilizam o banco central. O estoque é informado manualmente em Importar Bases, conforme a orientação mais recente do usuário. A operação financeira completa ainda depende dos módulos pendentes e de homologação remota.

## Contas a Pagar — 0.7.0

Consulta por mês de vencimento e macro, registro de pagamentos integrais com data/conta efetivas, revisão **A CONCILIAR / CONCILIADO**, correções auditadas e fechamento mensal com versões históricas. Um título só pode ser marcado **CONCILIADO** quando estiver integralmente pago. Alterações posteriores exigem nova conferência e fechamento; relatórios já salvos permanecem imutáveis. Reimportações atualizam o mesmo título por filial+número, sem apagar pagamentos; identificação ambígua bloqueia a operação.

A previsão cobre oito semanas de sábado a sexta, com provisões configuráveis por vigência, vínculo explícito de planos e cheques sem duplicidade. Excel inclui lançamentos, macros, comparação, pagamentos reais e realizados por macro. Falta de fonte fica pendente; ausência na importação não inventa pagamento.

Para atualizar o projeto existente, seguir [docs/ativacao-contas-pagar.md](docs/ativacao-contas-pagar.md): executar o novo combinado condicional `supabase/dashboard/ativar-contas-pagar.sql`, atualizar a função existente `payables-import` e aguardar o deploy do site. O combinado aplica somente as migrations faltantes de 012 a 018; mantém banco, usuários, saldos e históricos. Não repetir a instalação inicial.

## O que está implementado

React + TypeScript; login por usuário via gateway no Supabase; recuperação de senha por email com tela própria; RBAC consultado no banco; sessão em memória; logout e revogação; administração de perfis existentes no Auth; vínculo configurável entre login e cobradora; auditoria; mensagens da Diretoria/Gerência. As operações usam RLS e funções autorizadas no servidor.

O Painel preserva a organização e a marca da V75: Hoje/Semana/Mês, semana financeira de sábado a sexta, movimento, alertas e Resumo da Diretoria. Os indicadores disponíveis vêm do banco; fontes ausentes permanecem pendentes. Caixa é a posição atual na data oficial de São Paulo, independente do período escolhido para recebíveis e obrigações. A projeção exige as fontes necessárias e não confirma recebimentos.

**Importar Bases** centraliza as áreas autorizadas. Em **Caixa / Bancos**, a Gerência informa data, saldos das **17 posições: 12 contas bancárias e 5 caixas das empresas**, e observação, confere o consolidado e salva a posição inteira em uma transação. O cadastro segue a lista atualizada do usuário, incluindo Cora Ecoplast e os caixas de Ecoplast, Limpe Fácil, Gamma, Fast Clean e Easy Clean. Zero exige preenchimento explícito; valores de datas anteriores não são copiados automaticamente para um novo dia. Extratos de até 2 MiB são guardados como apoio privado, com hash e auditoria, sem alterar saldos ou conciliar títulos. A consulta de Caixa/Bancos e o estoque de contingência permanecem disponíveis conforme as permissões.

CP possui importação completa atômica, classificação obrigatória, baixas preservadas, filtros, paginação e CSV. CR possui importação completa com arquivo novamente analisado pelo servidor; novas ausências aguardam validação financeira, sem serem consideradas recebimentos. A carteira é herdada da dívida ativa do cliente quando existe uma atribuição oficial. Mudanças na identificação nome/CNPJ exigem conferência para evitar duplicidade; não há união automática. Cobrança oferece carteira individual, contatos, retornos e pagamento informado; CR confirma a data real ou devolve à mesma cobradora como não localizado. Registros de recebimentos validados preservam origem, cobradora e atraso, preparando a futura apuração de comissões.

Faturamento, Margens, Comissões, RH/DP, conciliação automática de extratos bancários, migração do estado operacional anterior e backups ainda estão pendentes. Também faltam criação completa de contas Auth, redefinição administrativa e troca obrigatória de senha. Não há valores fictícios nem bases V75 embutidas nos arquivos públicos.

## Atualizar o projeto existente

Para **0.6.0**, aplicar somente `supabase/migrations/013_director_report.sql` após confirmar a atualização 012 das contas. Seguir [docs/ativacao-resumo-diretoria.md](docs/ativacao-resumo-diretoria.md). Não repetir scripts anteriores nem alterar Edge Functions. As posições históricas permanecem intactas; ausência de dados bloqueia o cálculo, sem substituir por zero.

Para **0.5.0**, seguir [docs/estoque-manual.md](docs/estoque-manual.md): atualizar o site e usar o novo card em Importar Bases. O projeto já possui `save_manual_stock` e `current_stock`; esta mudança não exige nova migration nem Edge Function. O rascunho de integração automática foi retirado antes de publicação após a decisão do usuário por entrada manual.

Em **Importar Bases → Estoque**, a Gerência registra valor total, data de referência e observação. A posição alimenta o Painel e Caixa/Bancos a partir da mesma base, com histórico paginado, responsável e auditoria. Uma posição antiga não substitui outra de referência mais recente; ausência continua diferente de zero explícito. Não há integração com o portal interno, conector local ou chave de máquina nesta entrega.

A imagem completa confirmou as descrições e o usuário retirou M49 da fórmula. O Resumo da Diretoria calcula o Ativo Circulante no banco, com impostos do mês passado, 14% do faturamento geral e os demais componentes oficiais. Importar Bases → Resumo da Diretoria recebe os complementos diários conferidos pela Gerência, com auditoria e revisões; caixa, CR, estoque e mercadoria usam as bases centrais. O Excel contém a posição diária e a memória do cálculo. Detalhes: [docs/relatorio-diretoria-mapeamento.md](docs/relatorio-diretoria-mapeamento.md).

O usuário informou que login, Painel, onze saldos e uma base completa de CP já funcionam, e confirmou a execução sem erro da atualização 008/009/010/011. **Preservar esses registros e não repetir a instalação anterior.** Para **0.4.1**, seguir [docs/ativacao-contas-caixas.md](docs/ativacao-contas-caixas.md): executar somente `supabase/migrations/012_treasury_accounts.sql`. As seis novas posições são cadastradas sem saldo; os onze registros e valores existentes são preservados. Não é necessária outra Edge Function para bancos/caixas.

Contas negativas geram alertas de cobertura no mesmo dia no Painel e em Caixa/Bancos. A necessidade de cobertura soma somente os valores negativos, sem compensação com saldos positivos de outras contas; posições antigas solicitam atualização. Os quadros de contas possuem efeito discreto de elevação ao passar o cursor, respeitando redução de movimento.

A ativação de CR descrita em [docs/ativacao-recebiveis.md](docs/ativacao-recebiveis.md) ainda exige a função `receivables-import`; o sucesso do SQL não comprova que essa função já foi publicada. `auth-gateway` e `payables-import` existentes permanecem em uso. Não repetir o arquivo combinado 008/009/010/011 para acrescentar contas.

Não reaplicar 001/003/004/005/006/007 nem `ativar-financeiro.sql` no projeto já configurado. Para um projeto novo, consultar a ordem em [supabase/README.md](supabase/README.md). Deploy do site não executa migrations nem publica funções. Nunca executar reset contra o banco operacional.

## Desenvolvimento

Requisitos: Node 24 e npm 11. Não é necessário criar worktree; cada tarefa cloud já é isolada.

```sh
npm ci --cache /workspace/onboarding-tools/npm-cache --no-audit --no-fund
npm run dev
npm run build
```

`config/supabase.public.json` contém somente URL e chave **publishable**, públicas. O build funciona sem `.env.local`; as duas variáveis públicas da `.env.example` permitem selecionar outro projeto. O Vite rejeita chaves privadas antes de gerar o site. Senhas, chaves administrativas e tokens de provedor não pertencem ao frontend, ao Git ou ao chat.

Sem as funções publicadas, as operações correspondentes ficam indisponíveis. Não existe login de demonstração ou bypass offline. Tokens ficam somente na memória da aba; recarregar ou fechar exige novo login. Os dados oficiais permanecem no banco, sem localStorage como fonte. A sessão tem limite absoluto de doze horas, com perfil revalidado no servidor.

## Verificação

```sh
npm test
npm run test:sql
npm run test:auth-sql
npm run test:payables-sql
npm run test:payables-forecast-sql
npm run test:payable-payments-sql
npm run test:payable-identity-sql
npm run test:payable-closing-sql
npm run test:payable-full-payment-sql
npm run test:payables-operations-sql
npm run test:treasury-sql
npm run test:director-sql
npm run test:receivables-sql
npm run test:collections-sql
npm run test:bank-import-sql
npm run test:treasury-accounts-sql
npm run test:director-report-sql
npm run test:upgrade-sql
npm run bundle:receivables-gateway
npm run build
npm run test:browser
```

Os testes SQL usam PostgreSQL local via PGlite e Auth simulado. A suíte 015 preserva a evidência do ledger incremental; a regra operacional mais recente está na 018, que exige pagamento integral e testa a recusa de pagamento parcial na API. Gateway e navegador utilizam serviços sintéticos; não acessam dados financeiros reais. Chromium deste ambiente: `/usr/bin/chromium`, substituível por `CHROMIUM_PATH`. Resultados e limites de verificação estão em [docs/estado-verificacao.md](docs/estado-verificacao.md). Testes locais aprovados não comprovam publicação, entrega de email ou homologação remota.

## Hospedagem e dados anteriores

Frontend estático na Cloudflare Pages e banco/Auth/serviços no Supabase, independentes do PC da empresa. A base local fornece relatórios completos para atualização. A posição operacional antiga ainda precisa ser inventariada e migrada com conferência, sem substituir os saldos e títulos já lançados nem usar números de capturas de tela. Preservar o ZIP original e o estado operacional. Procedimentos: [publicação](docs/publicacao.md), [cadastro atual de contas/caixas](docs/ativacao-contas-caixas.md), [ativação de CR](docs/ativacao-recebiveis.md) e [mapeamento da V75](docs/v75-mapeamento.md).

Nenhum recurso pago é habilitado pelo código. Cotas, pausas e disponibilidade dos planos gratuitos precisam ser conferidas nos provedores. Backup/restauração de produção ainda requerem implantação e teste.
