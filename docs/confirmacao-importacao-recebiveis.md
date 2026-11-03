# Confirmação da importação de Contas a Receber — 0.18.19

O erro `CR_REQUEST_TIMEOUT` na etapa de confirmação informa que a resposta não chegou a tempo. O resultado permanece incerto até consultar o protocolo do envio: uma mensagem de tempo esgotado não comprova que a importação foi gravada nem que foi desfeita.

A atualização062 permite consultar a confirmação pelo protocolo sem reenviar o arquivo ou aguardar o bloqueio das operações financeiras. Também reduz as conferências repetidas durante a gravação do relatório completo. Os vínculos das parcelas, as responsáveis, a aprovação dos retornos, os recebimentos e os históricos continuam sendo conferidos.

## Ativação

1. Mantenha aberta a tela que contém a confirmação pendente.
2. Em outra aba, abra **Supabase → SQL Editor → New query**, cole todo o [SQL062 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-confirmacao-importacao-recebiveis.sql) e execute **Run**. É necessária a atualização047 do relatório completo; o arquivo inclui053,055,056 e057 quando ainda não instaladas.
3. Abra **Supabase → Edge Functions → receivables-import → Code → index.ts**, substitua todo o conteúdo pela [função completa atualizada](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/receivables-import.ts) e use **Deploy updates**.
4. Na tela original, clique em **Conferir confirmação pendente**. O mesmo protocolo é preservado. Uma confirmação já gravada pode ser recuperada também pela versão anterior da tela após a atualização do servidor.
5. Depois de resolver o envio pendente, atualize a Central com **Ctrl + F5** e confira a versão **0.18.19**.

A instalação preserva os dados atuais. Não é necessário limpar bases, excluir títulos ou reenviar um arquivo com outro nome.

## Quando a confirmação permanece pendente

Na versão0.18.19, **Conferir confirmação pendente** faz uma consulta ao resultado salvo. Se a consulta encontrar a confirmação do mesmo usuário, arquivo e protocolo, a tela apresenta o resultado e encerra a pendência.

Se o resultado ainda não estiver disponível, o arquivo e o protocolo permanecem preservados. A opção **Retomar o mesmo envio** reaproveita exatamente a tentativa original. A ausência de resultado na consulta não significa que uma execução ainda em andamento foi cancelada.

Uma alteração conhecida na base pode exigir uma nova análise. As aprovações individuais de retorno continuam obrigatórias para títulos quitados ou retirados que reapareçam no relatório.
