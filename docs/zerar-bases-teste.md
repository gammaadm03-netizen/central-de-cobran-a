# Limpar as bases de teste e iniciar a importação oficial

Esta rotina atende à limpeza solicitada antes da carga oficial. Ela remove as bases importadas e os registros operacionais relacionados, mantendo os acessos e as configurações da Central.

É uma operação administrativa de execução única, identificada por `preparacao-base-oficial-2026-10-22-v1`. O site não executa esta limpeza ao ser publicado. O procedimento não é uma migração, não exige uma Edge Function e não adiciona um botão de exclusão ao sistema.

## O que será limpo

A rotina contempla as 67 tabelas operacionais do modelo atual, conforme as atualizações instaladas:

- Contas a Pagar: importações, títulos, pagamentos, estornos, baixas, conciliações, posições dos relatórios diários de títulos e cheques, correções e fechamentos mensais.
- Contas a Receber: importações, títulos abertos e quitados, recebimentos, correções de quitações e registros de títulos ausentes dos relatórios completos.
- Cobrança: atendimentos, observações, retornos, cronômetros, contatos, descrições e preparação das importações de contatos e descrições.
- Caixa / Bancos, Estoque e Resumo da Diretoria: arquivos importados e posições financeiras, inclusive as posições manuais utilizadas nos testes.
- Fechamento / Faturamento e Custos: importações, itens, custos por produto e versões derivadas dos recálculos.
- RH / DP: bases importadas e seus arquivos originais.
- Comissões: apurações salvas a partir dos dados de teste.

Os pagamentos e recebimentos de teste não permanecem nos valores realizados nem nas comissões após a limpeza. Novos títulos e novas operações serão gerados a partir das bases oficiais.

## O que será preservado

Permanecem as contas de acesso, senhas, perfis, permissões, limitações individuais, autorizações especiais de importação, cobradoras e vínculos dos logins. As informações de autenticação e as sessões não são apagadas por esta rotina.

Também permanecem o cadastro de contas bancárias, os centros de custo macro, as classificações dos planos, as associações de bancos utilizados nas importações, as regras de previsão e de comissão, as mensagens da Diretoria e o registro das atualizações instaladas. A auditoria anterior é preservada e recebe o registro administrativo da limpeza.

As cinco tabelas de controle interno permanecem cadastradas e têm suas revisões atualizadas. Isso evita reutilizar uma conferência antiga da importação como se ainda correspondesse à base atual.

As configurações preservadas podem gerar previsões estimadas mesmo sem títulos importados. Por isso, limpar as bases não significa transformar todos os indicadores em zero. Uma posição de caixa ou estoque ainda não informada deve aparecer como **Não informado**, conforme a tela.

## Cópia privada antes da limpeza

Antes de remover qualquer registro, o SQL cria uma cópia privada das tabelas operacionais, com os tipos das colunas e o conteúdo original, inclusive os arquivos armazenados em colunas binárias. O conteúdo da cópia é conferido por SHA-256 e novamente validado na recuperação. A cópia e a limpeza fazem parte da mesma transação: se ocorrer uma falha, a operação não é concluída pela metade.

O resultado informa o nome dessa cópia no campo `backup_schema`. Guarde esse nome junto com o resultado da execução. A cópia não é exibida nas abas da Central e não é uma nova base financeira ativa.

Os arquivos de contatos e descrições que estão no bucket privado `collection-reference-files` do Supabase Storage permanecem como arquivo histórico. Eles não entram nos totais nem nas novas bases oficiais. Esta rotina não exclui registros de `storage.objects` nem remove os arquivos físicos do Storage.

## Como executar no Supabase

Faça a limpeza em um horário sem importações, conciliações ou atendimentos em andamento. A execução exige a conexão administrativa do proprietário no SQL Editor; os usuários normais da Central não podem chamar esta rotina.

1. Abra o projeto correto no Supabase: [Central Financeira — projeto sjimddcqgrsauzvffcol](https://supabase.com/dashboard/project/sjimddcqgrsauzvffcol/sql/new).
2. No menu do Supabase, entre em **SQL Editor → New query**.
3. Abra o [SQL completo de limpeza](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/admin/zerar-bases-teste.sql).
4. Copie o arquivo completo para a nova consulta. Cole somente o conteúdo SQL: não inclua mensagens do chat, marcações de Markdown ou código TypeScript de funções.
5. Confira que o editor está conectado ao projeto indicado acima, usando a conexão administrativa do proprietário, e clique em **Run**.
6. Aguarde o resultado. A conclusão normal informa **BASES_LIMPAS**, o nome da cópia privada, as tabelas processadas, a quantidade de registros removidos e a conferência de registros restantes.
7. Guarde o resultado da execução, principalmente `backup_schema`.

Se aparecer um erro, não considere a limpeza concluída. Preserve a mensagem completa para verificar a causa; o SQL executa a limpeza dentro de uma transação.

Esta rotina possui uma identificação fixa. Se o mesmo SQL for executado outra vez depois do sucesso, ele informa que a operação já foi executada e não limpa novamente os dados. Assim, repetir esta consulta não apaga as bases oficiais importadas posteriormente. Não altere a identificação da operação para repetir a limpeza.

## Depois da confirmação

Recarregue a Central ou saia e entre novamente antes de conferir os indicadores. As pessoas que estavam com o portal aberto também devem atualizar a página, para não continuar vendo informações de teste em memória.

Em **Importar Bases**, importe os relatórios oficiais de cada área. Nas bases que dependem de outra importação, respeite a sequência da própria tela: por exemplo, importe o fechamento do mês antes de aplicar uma base de custos a esse fechamento.

Confira o nome do arquivo, o período, os totais e a mensagem de conclusão de cada importação. A prévia da análise, sozinha, não significa que a base oficial foi gravada.

## Recuperação antes de iniciar a carga oficial

O arquivo [restaurar-bases-teste.sql](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/admin/restaurar-bases-teste.sql) serve exclusivamente para desfazer esta limpeza enquanto as tabelas operacionais ainda estiverem vazias. Execute-o, se necessário, no mesmo projeto, pelo **SQL Editor**, usando a conexão administrativa do proprietário e seguindo as instruções do próprio arquivo.

A restauração recupera os dados da cópia privada, incluindo os identificadores e os arquivos originais, respeitando as dependências entre as tabelas. Ela registra a recuperação e mantém os acessos e configurações preservados.

O SQL de restauração recusa a operação quando já houver novos dados operacionais. Ele não substitui nem mescla a carga oficial. Depois de iniciar as importações oficiais, não apague esses novos registros para forçar uma restauração: a recuperação precisa ser avaliada separadamente.

## Arquivos administrativos

- [Limpeza de execução única](../supabase/admin/zerar-bases-teste.sql).
- [Restauração protegida da cópia privada](../supabase/admin/restaurar-bases-teste.sql).

Os arquivos do repositório são instruções prontas para execução pelo proprietário. A existência desses arquivos e a publicação do site não comprovam que a limpeza foi executada no Supabase remoto.

## Validação local

`npm run test:base-reset-sql` executa 12 cenários de integração em PostgreSQL descartável, com dados fictícios. A verificação cobre as 59 tabelas instaladas, preservação de acessos e configurações, arquivos binários, falhas com reversão integral, cópia alterada, repetição após nova carga, restauração dos históricos e identidades e instalação parcial das atualizações. Nenhum teste acessa o banco remoto.
