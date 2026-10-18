# Contatos e descrições na Cobrança — 0.11.0

A orientação final é **mostrar as descrições somente no atendimento da aba Cobrança**. Não aparecem em Contas a Receber, Comissões ou títulos quitados. A base pode conter notas de títulos vencidos e a vencer; um título futuro só apresenta a descrição quando passar a integrar a cobrança ativa, após o vencimento pela data oficial de São Paulo.

Os contatos pertencem ao órgão/cliente e são compartilhados entre seus títulos. Email e telefone ausentes permanecem em branco para atualização pela cobradora. Vários emails ou telefones podem ser preservados. O cadastro mostra responsável/data da atualização e permite consultar cobertura e alterações em relatório. Alterações manuais, inclusive exclusões de campos, têm prioridade sobre novas importações da lista inicial. Os contatos válidos por nome exato também ficam cadastrados quando o órgão ainda não tem título ativo. Assim, novos títulos podem utilizar a lista inicial sem uma nova importação de contatos; a consulta continua limitada à carteira autorizada de títulos vencidos. Nomes que possam corresponder a outro cadastro identificado por CNPJ permanecem pendentes de conferência.

## 1. Atualizar o banco existente

No Supabase, abrir **SQL Editor → New query**. Copiar e executar o arquivo inteiro:

**[supabase/dashboard/ativar-recebiveis-operacao.sql](../supabase/dashboard/ativar-recebiveis-operacao.sql)**

O combinado condicional foi ampliado para **022..028**. Em uma base 0.10.0 completa, instala somente **027_collection_customer_context** e **028_collection_reference_imports**. Versões já registradas são preservadas; uma falha desfaz a transação inteira. Não executar também as migrations individuais nem repetir a instalação inicial, remover tabelas ou fazer reset.

A atualização acrescenta contatos, histórico, vínculos de descrições e importações privadas. Cria o bucket **collection-reference-files**, privado, com políticas específicas para a sessão/perfil autorizado. Não cria usuários, títulos, pagamentos ou saldos e não altera os valores financeiros, responsáveis ou cronômetros existentes. O Storage normal do projeto Supabase precisa estar disponível.

**“Success. No rows returned” é sucesso de execução do SQL.** Não significa que uma planilha já foi importada ou que a função foi publicada.

## 2. Publicar uma nova Edge Function

Este arquivo é TypeScript e **não deve ser colado no SQL Editor**:

**[supabase/dashboard/collection-reference-import.ts](../supabase/dashboard/collection-reference-import.ts)**

1. Abrir **Edge Functions → Deploy a new function → Via Editor**.
2. Substituir o conteúdo de **index.ts** pelo arquivo completo acima.
3. No campo **Function name**, junto ao botão de publicação na parte inferior, informar exatamente **collection-reference-import**.
4. Clicar em **Deploy function**.
5. Na função publicada, abrir **Settings**, desligar **Verify JWT with legacy secret** e salvar. O código valida o token no Auth, a sessão aprovada e as permissões no banco.

Manter o secret existente **ALLOWED_ORIGINS** com `https://central-de-cobran-a.pages.dev`, sem barra final. Não alterar `auth-gateway`, `payables-import` ou `receivables-import`. Uma função com nome automático não substitui o nome exigido. As credenciais privadas são usadas somente pelo runtime Supabase e não devem ser copiadas para a Cloudflare, para o site ou para o chat.

## 3. Conferir o site

O site continua em **https://central-de-cobran-a.pages.dev**. Após o deploy da branch `main`, conferir **Versão 0.11.0**; atualizar com **Ctrl + Shift + R** se necessário. Deploy do site não executa SQL nem publica a função acima.

## 4. Importar os arquivos reais

Como Gerência ou Contas a Receber com autorização de importação, abrir **Importar Bases → Contatos e descrições**. Escolher o tipo antes do arquivo, aguardar a preparação, conferir a prévia do servidor e confirmar a publicação.

- **Contatos iniciais:** selecionar `CONTATOS.xlsm.xlsx`. Cabeçalhos: `Entidade: nome`, `Endereço: email`, `T. 1: ddd`, `T. 1: número`. Linhas repetidas podem acrescentar canais ao mesmo cliente; linhas sem nome não são associadas ao cliente da linha anterior. Emails inválidos não viram contatos válidos. Pendências ficam separadas para conferência, sem impedir o aproveitamento dos registros utilizáveis.
- **Descrições de contratos:** selecionar `ORGÃOS E DESCRIÇÕES.xlsx`. Cabeçalhos: `CLIENTE`, `CONTRATO`, `NOTA FISCAL`, `DESCRIÇÃO`, `FILIAL`. O número do contrato é opcional. Importar primeiro a base financeira de abertos e vencidos para que os títulos existam. Nas próximas atualizações, importar os novos registros de descrições; não é necessário recadastrar contatos já mantidos pelas cobradoras.

O vínculo de descrição confere **nota fiscal + filial + cliente exato**, sem aproximação de nomes. Não une clientes só porque a nota/filial coincide, não cria dívidas e não considera títulos ausentes como pagos. Variações de descrição/contrato sem data de versão são preservadas para conferência; a última linha não é presumida como a versão correta. Números identificadores não são convertidos em valores financeiros.

Na primeira base de contatos há muitos telefones ausentes e alguns emails inutilizáveis. O relatório deve distinguir campos preenchidos de dados efetivamente revisados pela equipe; preenchimento não comprova que email ou telefone funcionam. Evitar publicar os arquivos e os contatos em repositórios ou links públicos.

## 5. Usar o atendimento e acompanhar a atualização

Em **Cobrança → Títulos**, abrir um título vencido da carteira autorizada. A seção de contatos permite preencher/corrigir os canais e salvar no banco. As descrições disponíveis aparecem nesse mesmo atendimento. A Diretoria consulta sem alterar; cobradoras atualizam os clientes autorizados de sua carteira. A conferência do contato é independente do status financeiro e do tempo de trabalho.

Em **Cobrança → Contatos**, consultar a cobertura do cadastro e o histórico de alterações com os filtros disponíveis. Exportações respeitam os mesmos acessos. A Gerência pode acompanhar clientes sem email/telefone e contatos ainda não revisados, em vez de depender de uma planilha paralela.

## Arquivos, capacidade e retomada

A importação de apoio é separada da importação financeira. Aceita originais de até **16 MiB**, planilhas com expansão limitada a **128 MiB** e até **300 mil linhas**, com cache de textos compartilhados limitado a **14 MiB**. O arquivo original permanece no Storage privado. Um worker no navegador converte os dados em pequenos CSVs, com controle de fluxo; o gateway interpreta e valida esses CSVs no servidor e preserva seus bytes/hash privados associados ao original. A verificação do hash do original não significa que o Excel inteiro foi reinterpretado no Edge.

A preparação ocorre em lotes privados; a publicação oficial é transacional. Depois de resposta incerta, retomar a mesma importação/requisição, sem criar confirmações duplicadas. O fechamento da aba pode interromper a preparação; verificar o estado antes de reiniciar. Nenhum original ou CSV de apoio é publicado no site ou no Git.

Os limites financeiros existentes de CP/CR permanecem independentes. Não usar essa função para importar valores ou quitar títulos. As planilhas enviadas no chat foram analisadas localmente, mas só estarão na base operacional depois da ativação e da importação confirmada no sistema.
