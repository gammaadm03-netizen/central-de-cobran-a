# Importar e revalidar parcelas de Contas a Receber — 0.15.0

A atualização 0.15.0 otimiza a busca das parcelas existentes no banco, amplia o tempo disponível para a função de importação e mostra uma referência segura quando a operação falha. A otimização usa os campos do índice já existente antes de conferir a identidade completa da parcela; o critério exato de vínculo permanece igual. Não transforma divergências em novas parcelas nem confirma recebimentos por ausência no relatório.

O registro analisado mostrou uma resposta HTTP 503 após cerca de 10,6 segundos, compatível com o limite compartilhado anterior de 10 segundos da função. Esse indício não comprova a causa de todo erro 503 nem descarta um limite de execução no próprio banco. Os tempos das consultas também foram comparados localmente; isso não confirma o desempenho ou a ativação no projeto remoto.

## Atualizar o projeto existente

1. Abra o [SQL completo de otimização 041](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-otimizacao-importacao-recebiveis.sql) e copie todo o arquivo. Em **Supabase → SQL Editor → New query**, cole e execute **Run**. Ele requer as atualizações de recebíveis **023/024** e o índice da 023 já instalados. Não altera títulos, recebimentos ou vínculos salvos.
2. Abra **Supabase → Edge Functions → receivables-import → Code → index.ts**. A função é a **receivables-import já existente**.
3. Abra o [código completo atualizado da função](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/receivables-import.ts), copie **todo o arquivo**, substitua todo o conteúdo de `index.ts` e clique em **Deploy updates**. Esse arquivo é TypeScript e pertence ao editor da Edge Function, separado do SQL executado no primeiro passo.
4. Aguarde a atualização do site e confira **Versão 0.15.0** no rodapé. Atualize a página se necessário. A publicação no Git não executa o SQL, não atualiza a função no Supabase e não comprova que o deploy remoto terminou.
5. Abra novamente a mesma cópia do relatório, confira as escolhas de parcelas e revalide antes de confirmar. Se precisar recarregar a página, anote as escolhas corretas antes; o arquivo selecionado e os rascunhos da tela não são uma base persistida.

A função passa a ter um orçamento de até **50 segundos** para autenticação, leitura e chamadas ao serviço de dados; o site espera até **60 segundos** pela resposta. Esses limites não substituem os limites de execução ou bloqueio do PostgreSQL. A atualização 041 é independente do rascunho de e-mail da Cobrança **040**: executar a 040 não corrige a importação de Contas a Receber, e ela não é requisito para esta correção.

O aviso “Confirme se esta linha é uma nova parcela ou uma alteração de vencimento de um título existente” indica que já há título com o mesmo cliente, filial e documento, mas sem vínculo salvo para aquele vencimento. A ausência de um código único de parcela no relatório exige confirmar qual parcela corresponde à linha. A Central não escolhe pelo número da nota nem pelo valor recebido.

## Conferir e validar as escolhas

1. Na seção **Conferir parcelas do mesmo documento**, confira as linhas indicadas.
2. Escolha a parcela existente quando for o mesmo título; escolha **Nova parcela** somente quando for outra parcela do documento. Não marque todas as linhas como novas para contornar um erro de análise: isso pode representar a mesma dívida duas vezes.
3. Clique em **Validar escolhas de parcelas**, junto à tabela de vínculos. O botão reanalisa o mesmo arquivo e não conclui a importação.
4. Confira a nova análise e só então confirme a importação pelo botão correspondente ao relatório de abertos ou quitados.

Após alterar escolhas, o diagnóstico anterior fica identificado como **Análise anterior**. Ele só é substituído quando a nova análise termina. Uma falha de reanálise preserva as escolhas e a prévia anterior, mantendo a confirmação bloqueada até existir uma nova análise válida. A escolha só se torna permanente depois da importação confirmada; o mesmo cliente, filial, documento e vencimento poderá usar o vínculo salvo nas próximas importações. Um novo vencimento ainda não vinculado pode exigir conferência novamente.

## Quando a função não aplicar o vínculo enviado

Se a própria análise enviar uma escolha explícita e a resposta continuar tratando aquela linha como ambígua, a tela informa **“A função de importação não aplicou os vínculos selecionados”**. O arquivo e as escolhas são preservados; o sistema não libera a importação nem presume outra parcela. Um conflito financeiro legítimo conserva sua mensagem original.

Siga a atualização da função existente descrita acima e valide novamente os vínculos corretos. Não é necessário criar outra função ou limpar dados para reaplicar uma escolha. Se o problema continuar, envie somente a referência de suporte apresentada pela tela.

## Se a análise ou a confirmação falhar

A tela exibe **Código para suporte:** com a etapa, o status HTTP, um código permitido e, quando disponíveis, a versão da função e um identificador da solicitação. Copie somente essa linha para suporte. Ela não inclui dados de clientes, títulos, credenciais ou o texto bruto de erros SQL. Não é necessário enviar tokens, chaves, senhas ou o conteúdo integral dos logs.

- **57014** indica uma consulta cancelada no banco, inclusive por limite de execução. É diferente de um limite da função ou da espera no navegador; o código sozinho não determina a origem de todo cancelamento.
- **55P03** indica espera por bloqueio no banco; **CR_UPSTREAM_TIMEOUT** identifica limite de resposta do serviço de dados.
- **CR_REQUEST_TIMEOUT**, **CR_NETWORK_ERROR** e **CR_SERVICE_UNAVAILABLE** distinguem limite de espera, falha de comunicação e indisponibilidade. **SERVIÇO SEM DIAGNÓSTICO** significa que a resposta não trouxe o diagnóstico reconhecido, por exemplo em uma função antiga; não identifica sozinho a causa.

Se a falha ocorrer na **CONFIRMAÇÃO**, uma resposta interrompida não comprova se a importação foi concluída. Confira o histórico da importação antes de tentar novamente. Preserve o arquivo e as escolhas; não faça novas parcelas por tentativa. Uma falha na análise não autoriza concluir com a prévia anterior.

## Limite da verificação

O fluxo de vínculos explícitos foi ensaiado localmente com títulos sintéticos. A otimização da 041 preserva o predicado completo de identificação e foi comparada com o resultado anterior em ambiente local. Esses ensaios não identificam qual versão de função está publicada no projeto do usuário nem confirmam uma importação de produção. Nenhuma proteção de identidade, recebimento, carteira ou histórico foi removida.
