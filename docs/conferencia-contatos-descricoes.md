# Conferência de contatos e descrições — 0.18.4

Esta atualização corrige trabalho repetido na análise de **Importar Bases → Contatos e descrições**. A classificação usa as chaves já preparadas e reutiliza o resultado somente enquanto as revisões da carteira e dos contatos permanecem iguais. As contagens, pendências e o progresso de publicação continuam sendo consultados em cada conferência. Uma mudança na base exige nova classificação.

O banco limita a espera por bloqueios a cinco segundos nessas operações. A função de importação passa a aguardar até 50 segundos pela solicitação e o site aguarda até 60 segundos pela resposta. Esses prazos não alteram o limite de execução configurado no próprio banco. Falhas mostram uma referência segura para suporte, com etapa, código e identificador, sem expor o conteúdo do arquivo ou mensagens internas do banco.

## Ativar no Supabase

Publicar o site não executa SQL nem atualiza Edge Functions. São duas instalações separadas, sem necessidade de apagar ou reenviar as preparações existentes.

1. Abra o [SQL 048 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-conferencia-contatos-descricoes.sql). Use **Ctrl+A → Ctrl+C** nessa página. Em **Supabase → SQL Editor → New query**, cole todo o conteúdo e clique em **Run**. Requer as atualizações 028 e 047; a instalação verifica as dependências. A repetição após uma instalação concluída é segura.
2. Abra o [código completo da função](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/collection-reference-import.ts). Use **Ctrl+A → Ctrl+C** nessa página. Em **Supabase → Edge Functions → collection-reference-import → Code**, substitua todo o conteúdo de **index.ts**, salve e clique em **Deploy updates**. Atualize a função existente com esse nome. Esse arquivo é TypeScript e pertence à Edge Function.
3. Recarregue a Central e confira a versão **0.18.4**.

Os arquivos também estão no repositório: [SQL 048](../supabase/dashboard/ativar-conferencia-contatos-descricoes.sql) e [função completa](../supabase/dashboard/collection-reference-import.ts). Os links acima abrem o conteúdo integral, sem depender da visualização parcial do arquivo.

## Retomar os arquivos preparados

1. Acesse **Importar Bases → Contatos e descrições → Histórico dos seus arquivos**.
2. Na linha do arquivo, clique em **Conferir**. Faça isso separadamente para contatos e descrições. Não é necessário selecionar o arquivo novamente quando ele está **Pronto para conferência**.
3. Confira os vínculos e as pendências. Referências sem título correspondente, ambiguidades, dados inválidos e descrições de títulos já quitados continuam separados dos registros elegíveis.
4. Quando houver pendências, leia a orientação e confirme sua ciência antes de clicar em **Concluir importação deste arquivo**. Conferir e preparar não publicam os dados de apoio por conta própria.

Contatos alterados manualmente pelas cobradoras são preservados. Descrições permanecem restritas à Cobrança: títulos a vencer podem receber o vínculo, exibido no atendimento quando estiverem vencidos. Títulos quitados ou retirados da carteira ativa não recebem um novo vínculo ativo.

Se ocorrer uma falha na conferência, use **Conferir** ou **Reanalisar arquivo preparado** para retomar o mesmo arquivo. Se a falha ocorrer durante a conclusão, mantenha a tela aberta e use **Conferir confirmação pendente**, que repete o mesmo protocolo sem criar outro envio. O código para suporte diferencia demora, bloqueio no banco, indisponibilidade e resposta incompatível.

## Validação local

`npm run test:collection-reference-analysis-sql` verifica a atualização em banco descartável com 63.780 descrições e 4.356 contatos, reutilização e invalidação da análise, preservação de dados manuais, publicação e permissões. Os testes de serviço e navegador verificam a retomada do mesmo arquivo após falhas. Esses testes não executam importações ou instalações no Supabase de produção.
