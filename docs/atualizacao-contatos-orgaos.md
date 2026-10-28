# Atualização dos contatos dos órgãos

Em **Importar Bases → Contatos e descrições → Contatos dos clientes**, a Central aceita o novo relatório com as colunas:

| Coluna | Uso |
| --- | --- |
| Entidade: nome | Identificação do cliente pelo nome cadastrado |
| E-mails | Um ou mais endereços, inclusive separados por quebra de linha |
| Telefones | Números completos com DDD e números 0800 explícitos |
| WhatsApp cadastrado | Números declarados como WhatsApp pela origem |

O formato anterior, com **Endereço: email**, **T. 1: ddd** e **T. 1: número**, continua aceito. A cópia original e as linhas físicas são preservadas. Nomes ou CNPJs ambíguos permanecem para conferência; a importação não adivinha a identidade do órgão.

## O que é atualizado

Os contatos válidos de cada cliente presente no arquivo substituem os e-mails, telefones e observações importados anteriormente. Contatos antigos que não constam mais para aquele cliente saem da ficha atual, preservando o antes/depois na auditoria. Várias linhas válidas do mesmo cliente são agrupadas antes da atualização.

Clientes ausentes do arquivo continuam com seus contatos atuais. Uma ficha editada manualmente na Central é preservada por inteiro, incluindo inclusões, correções e exclusões. A prévia informa quantas fichas manuais foram preservadas.

Se houver uma linha inválida de um cliente, o conjunto desse cliente permanece pendente, evitando substituir sua ficha por parte das informações. Limites de canais consideram os dados do arquivo atual, sem somar números antigos que serão substituídos. Arquivos preparados antes de uma atualização já confirmada mais recente não sobrescrevem os contatos daquele cliente.

Os números de WhatsApp explícitos entram nos telefones e ficam identificados nas **Observações**, com o texto **WhatsApp cadastrado**. Telefones comuns não recebem essa indicação. Ramais permanecem nas observações com o texto original, e a linha principal fica disponível como telefone; esses casos geram aviso para conferência. Não se presume DDD ou país ausente.

## Importar

1. Selecione **Contatos dos clientes** e escolha o novo arquivo.
2. Clique em **Preparar e conferir arquivo**.
3. Confira os registros aproveitáveis, as fichas manuais preservadas e os avisos. Confirme a leitura dos avisos quando solicitado.
4. Clique em **Concluir importação deste arquivo** e aguarde a mensagem de conclusão.

Apenas preparar ou conferir não atualiza os contatos. Uma confirmação com resposta interrompida pode ser retomada pelo mesmo protocolo, sem duplicar a importação. Arquivos concluídos permanecem no histórico. A importação não altera títulos, responsáveis, valores, pagamentos ou comissões.

## Ativação da versão 0.18.9

1. Abra o [SQL completo de atualização dos contatos](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-atualizacao-contatos-orgaos.sql), copie tudo e execute em **Supabase → SQL Editor → New query → Run**. O arquivo reúne 048, 049 e 052, preserva atualizações já instaladas e requer a estrutura 047 existente. Ele não importa o relatório.
2. Abra o [código completo de collection-reference-import](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/collection-reference-import.ts). Em **Supabase → Edge Functions → collection-reference-import → Code → index.ts**, substitua o conteúdo inteiro e clique em **Deploy updates**.
3. Atualize a Central até a versão **0.18.9** e importe o arquivo novo.

As três partes precisam estar atualizadas: tela, banco e função. A tela bloqueia a atualização de contatos quando o banco ainda não confirma a versão 052. As funções de descrições continuam com o mesmo comportamento.

## Verificação

O relatório fornecido tem **208 órgãos**, **277 e-mails** e **386 canais telefônicos**, incluindo seis números 0800. Dez linhas declaram WhatsApp e onze incluem ramais. A leitura local preservou essas informações, sem linhas inválidas; os ramais geram avisos para conferência. Essa leitura não comprova importação nem correspondência com a carteira de produção.

As alterações são verificadas por testes de parser, gateway, SQL em PostgreSQL descartável e navegador. Os arquivos reais de contatos permanecem fora do repositório público.
