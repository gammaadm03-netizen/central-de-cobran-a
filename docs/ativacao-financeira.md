# Ativar Painel, Caixa e importação de CP — 0.3.0

Esta atualização porta a primeira parte financeira da V75. Não restaura automaticamente dados históricos nem conclui os demais módulos.

## Pré-requisitos

Manter o projeto Supabase já configurado com as migrations 001, 003 e 004, a conta administrativa e a função `auth-gateway`. Não repetir o bootstrap de usuários nem redefinir o banco. Preservar o ZIP original e uma cópia dos dados operacionais existentes. O deploy do frontend não executa migrations.

## 1. Banco: executar uma única atualização

No SQL Editor do projeto atual, criar uma nova consulta e copiar o conteúdo completo de `supabase/dashboard/ativar-financeiro.sql`. Executar uma vez. Esse arquivo reúne 005/006/007 em uma transação única: se ocorrer erro, nenhuma das três é aplicada. Não executar os arquivos individuais além do arquivo combinado.

O script cria tabelas e funções incrementais para CP, saldos, estoque manual e snapshots. Cadastra somente as onze contas bancárias oficiais, os macros permitidos e as três classificações expressamente definidas. Não cadastra saldos, títulos, estoque ou valores fictícios. Mantém usuários, permissões, mensagens e auditoria existentes.

Se já aplicou alguma das migrations 005/006/007 separadamente, não repetir o arquivo combinado. Conferir o histórico e aplicar somente as ausentes. Em caso de erro, preservar a mensagem técnica no painel administrativo e investigar, sem apagar tabelas ou executar reset.

## 2. Publicar o serviço de importação

Em Edge Functions, criar uma nova função com nome exato **payables-import**. Copiar todo o conteúdo de `supabase/dashboard/payables-import.ts` para o `index.ts` do editor e publicar.

Em Settings dessa função, desativar **Verify JWT with legacy secret** e salvar. A função valida o token diretamente no Supabase Auth, consulta a sessão aprovada e as permissões oficiais antes de analisar arquivos. Isso não torna a importação pública.

O secret `ALLOWED_ORIGINS` já utilizado pelo login deve conter a origem exata `https://central-de-cobran-a.pages.dev`, sem barra final. As variáveis privadas do runtime são fornecidas pelo Supabase; não copiar nenhuma chave privada para o código, Git ou chat. A função `auth-gateway` existente não precisa ser substituída nesta atualização.

O arquivo gerado importa ExcelJS 4.4.0 pelo suporte npm do runtime Deno. Nenhum produto pago é ativado pelo código. Confirmar limites do plano gratuito no painel; não habilitar billing para contornar um erro de configuração ou limite.

## 3. Site e primeira utilização

A integração Git da Cloudflare recebe o código da versão 0.3.0. Aguardar build/deploy concluído e atualizar a Central. O endereço permanece o mesmo.

1. Entrar como Gerência Geral e abrir Caixa / Bancos. Informar a posição de cada conta com data e observação. A ausência de qualquer conta deixa o total consolidado pendente; zero só existe quando informado explicitamente.
2. Informar estoque manual de contingência se houver posição conhecida. A origem e a data ficam visíveis; ausência de estoque continua pendente.
3. Abrir Importar Bases → Contas a Pagar. Selecionar o relatório completo do grupo consolidado. Conferir todos os planos e definir os macros desconhecidos. A conclusão exige confirmação dos novos, mantidos e títulos desaparecidos que serão quitados por importação.
4. Consultar CP e o Painel. Atualizar os indicadores após novos saldos/importações. Conferir totais com o relatório de origem e verificar eventos na Auditoria.

Nesta entrega são aceitos `.xlsx`, `.xlsm` e `.csv` UTF-8, até 2 MiB, uma única aba com dados, 5.000 títulos e 100 colunas. O original permanece intacto e uma cópia é arquivada privadamente no banco junto ao lote. Para `.xls`, salvar uma cópia como `.xlsx`. Fórmulas precisam ser convertidas em valores na cópia de importação; macros nunca são executadas. A interface e o servidor validam linhas e cabeçalhos, mas somente o servidor deriva os lançamentos que podem ser gravados.

Não importar um relatório filtrado. Todas as filiais devem estar na mesma origem completa `grupo-consolidado`; escopos alternativos são recusados para evitar duplicação do consolidado. Uma base vazia não pode efetuar baixas. Arquivo repetido, classificação pendente ou análise desatualizada bloqueiam a transação inteira.

## Regras preservadas e limites atuais

- Semana financeira: sábado a sexta. Datas civis e auditoria apresentados em America/Sao_Paulo.
- CP: novo, permanece aberto e desaparecido quitado por importação. Baixas são preservadas no histórico, com data e auditoria; não há exclusão física. Reaparecimento mantém o registro e registra reabertura.
- Diretor consulta CP/Caixa/Painel e mantém apenas a exceção de escrita do quadro de mensagens; não importa, altera saldo, estoque ou salva snapshots.
- Somente Gerência/CP importam CP. CR, RH e cobradoras não recebem títulos CP pela API. O Painel autorizado pode obter agregados, sem acesso aos lançamentos CP.
- O Resumo da Diretoria salva posições parciais imutáveis calculadas no servidor. Caixa é o saldo atual mostrado no painel; CP segue o período selecionado. Fontes não implantadas permanecem nulas no histórico.
- Exportação CSV de CP respeita filtros e cancela se a base mudar. O resumo possui Excel e impressão/PDF. Relatório CP Excel por macro/mês completo, previsões fixas e próximas oito semanas ainda não foram portados.
- CR, Cobrança/validação, Faturamento, Margens, Comissões e RH continuam pendentes. O painel não inventa recebíveis, faturamento, margens ou caixa projetado. Ativo circulante aguarda todas as entradas e parâmetros da fórmula oficial.

## Migração da posição anterior

O ZIP contém bases embutidas históricas. O estado operacional mais recente está no arquivo `CentralFinanceira_Dados/central_state.json` da máquina antiga ou nos navegadores usados na operação. Essas fontes ainda precisam ser inventariadas, comparadas e migradas com relatório de contagens/totais. Não substituir a posição atual por valores de uma captura de tela. O mapeamento técnico está em `docs/v75-mapeamento.md`.

## Verificação local

Executar `npm ci`, `npm test`, `npm run test:payables-sql`, `npm run test:treasury-sql`, `npm run test:director-sql`, `npm run bundle:payables-gateway`, `npm run build` e `npm run test:browser`. Os testes usam Auth/HTTP sintéticos e PostgreSQL local PGlite. Aprovação local não comprova execução remota das migrations, publicação da função ou homologação da posição real.
