# Publicação de homologação — 0.1.2

Esta entrega prepara acesso e administração. Os módulos financeiros ainda não estão operacionais. Não direcionar a equipe para trabalho financeiro nesta versão.

## 1. Banco

O usuário informou que executou001 e ativou a Gerente. Confirmar no projeto correto. Executar **uma vez** `supabase/migrations/003_auth_gateway.sql` no SQL Editor. O script é transacional e não apaga registros. Se houver conflito, investigar; não excluir tabelas para contornar. Sem003 o gateway não funciona.

## 2. Site estático

Criar conta da empresa no Cloudflare e projeto **Pages** em modalidade gratuita disponível. Sem ativar billing. Pode usar upload direto dos arquivos `dist/` gerados por `npm run build`; o ZIP de publicação deve conter index.html na raiz. Escolher nome de projeto. O endereço HTTPS real do provedor será a origem permitida do gateway; não usar domínio fictício nem presumir nome disponível. Domínio próprio é opcional.

Na integração por Git, usar build `npm ci && npm run build`, saída `dist` e Node24. O projeto padrão vem de `config/supabase.public.json`, somente URL e chave pública; não depende de variáveis manuais na Cloudflare. Para outro projeto, substituir pelas duas variáveis públicas da `.env.example` nas configurações do build. O repositório da aplicação precisa conter estes arquivos antes da integração. Confirme que a branch selecionada possui package.json, src/ e vite.config.ts; não associe uma branch vazia esperando que o provedor encontre arquivos de outra máquina.

O arquivo `_headers` acompanha o build. Esta versão navega na própria página e não precisa de regra global de redirecionamento. A política CSP não autoriza execução de scripts inline nem de origem externa. Não colocar o HTML V75 ou JSON de usuários neste site.

## 3. Gateway

Seguir `supabase/README.md`. É possível publicar a função pelo editor do painel. O helper `npm run bundle:gateway` gera uma versão de arquivo único, sem chaves, para facilitar colagem no editor como `index.ts` da função `auth-gateway`. A função precisa de verificação JWT do gateway desativada apenas para esse endpoint de login; o próprio código valida sessões quando necessário. Não desativar RLS.

Em Secrets da Edge Function, definir `ALLOWED_ORIGINS` com a URL HTTPS real do Pages, sem barra final. O runtime fornece as chaves privadas; não enviá-las para chat, frontend ou Git. Sem origem configurada, o login falha fechado. Não usar `*`.

## 4. Homologação remota necessária

- Login como Gerente com senha digitada somente na tela HTTPS; confirmar perfil oficial.
- Testar senha inválida, usuário bloqueado, sessão expirada e logout.
- Reutilização de JWT revogado deve falhar em current_access e nas tabelas.
- Diretor deve negar administração e permitir somente mensagens em escrita.
- Cobradoras devem ver só seus vínculos e, quando a carteira for implementada, só seus títulos.
- Criar/concluir/reabrir mensagem e conferir auditoria com Gerente.
- Testar acesso de rede externa com PC da empresa desligado.
- Novo deploy não deve alterar perfis, mensagens ou auditoria existentes.

Não gravar senhas/tokens em logs ou comandos de teste. Não afirmar versão pronta antes da integração remota e da implementação dos módulos financeiros.

## Recuperação

Preservar banco e ZIP original V75. Publicar código não substitui backup. Falha de gateway deve mostrar indisponibilidade, nunca liberar acesso. Não restaurar estado vazio como solução. Se migration falhar, sua transação deve reverter; conferir resultado antes de repetir. Backup/restauração de produção ainda precisam de implantação e teste.
