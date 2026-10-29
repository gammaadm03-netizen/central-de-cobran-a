# Conciliação e aprovação de retorno de recebíveis — 0.18.13

## Conferência dos totais

O total do arquivo de abertos pode incluir títulos já quitados na Central. O saldo da carteira ativa exclui esses títulos. A prévia identifica a quantidade e, quando todos os vínculos necessários estiverem disponíveis, mostra o valor nominal correspondente, o subtotal do arquivo ainda não quitado e uma lista própria dessas parcelas. Quando a informação disponível não comprova todos os vínculos, a tela informa a limitação e não estima a diferença.

A aprovação de retorno se aplica a **títulos quitados** e a **títulos retirados por ausência em um relatório completo anterior**, mesmo que ainda não exista recebimento confirmado. Atualizações de títulos que continuam ativos seguem a conciliação habitual.

## Aprovar o retorno

1. Entre com o perfil **Gerência Geral**. Abra **Importar Bases → Contas a Receber → Abertos e vencidos**.
2. Selecione o relatório atualizado, informe se é completo ou somente inclusão e atualização e clique em **Analisar arquivo**.
3. Confira cada caso em **Retornos para conferência da Gerência**: cliente, documento, filial, vencimento, valor original e eventual recebimento já validado.
4. Informe a justificativa e clique em **Aprovar retorno** para a parcela correspondente. Exemplos de motivos devem descrever o caso real, como uma validação anterior feita por engano. Não aprove retorno de um pagamento efetivamente recebido sem conferir a origem.
5. Reanalise o arquivo depois de registrar as aprovações. A mesma Gerência que aprovou deve concluir a importação. Confira também vínculos e responsáveis exigidos pela análise normal.
6. Clique em **Confirmar importação**. O banco confere novamente a parcela, a revisão, o recebimento e os dados aprovados antes de aplicar o arquivo.

Operadores sem o perfil de Gerência consultam os casos, mas não aprovam nem concluem retornos. Cada parcela exige sua própria decisão e justificativa. Uma aprovação não se aplica a outra parcela, a outro valor ou a um recebimento alterado depois da conferência.

## Quando os dados mudam

A aprovação isolada não altera o saldo, não estorna recebimentos e não recoloca o título na carteira. Ao confirmar o arquivo, o retorno e o eventual estorno são feitos junto com a importação. Se uma etapa falhar, as alterações financeiras dessa confirmação são desfeitas em conjunto.

No retorno de uma quitação incorreta, o recebimento original permanece imutável e ganha um registro de estorno com motivo, responsável e data. O título conserva sua identidade, valor original, vencimento, responsável e histórico de cobrança. O recebido estornado deixa os recebimentos vigentes e a base atual de comissões. Apurações já salvas mantêm sua posição histórica; consulte a base atual para uma nova apuração.

Um título retirado e sem recebimento volta após a aprovação e a confirmação do arquivo, com o mesmo vínculo e histórico. Não é criado um recebimento pela ausência ou pelo retorno. Um pagamento correto posterior pode ser confirmado no mesmo título, preservando o registro estornado anterior.

O histórico do título mostra o recebimento estornado e seu motivo. Relatórios antigos de quitados que ainda apontem recebimentos estornados podem exigir uma nova conferência da origem; repetir um arquivo antigo não recria automaticamente o pagamento desfeito.

## Resposta interrompida

Se a resposta de uma aprovação ou importação se perder, mantenha a tela aberta e utilize a opção de conferir a operação pendente. A Central repete o mesmo protocolo e os mesmos dados. Ela não cria outra aprovação, outro estorno ou outro título por causa dessa repetição. Enquanto o resultado estiver incerto, os campos e a navegação ficam bloqueados.

## Ativação

1. Abra o [SQL 057 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-aprovacao-retorno-recebiveis.sql).
2. Copie todo o conteúdo para **Supabase → SQL Editor → New query** e clique em **Run**.
3. Atualize a Central para a versão **0.18.13**.

O arquivo requer a atualização 047 e inclui 053, 055, 056 e 057 quando ainda não estiverem instaladas. Pode ser executado novamente. A instalação não estorna nenhum recebimento real nem aprova retornos automaticamente. Não é necessário alterar Edge Functions.

## Verificação local

As suítes `test:receivable-receipt-reversal-sql`, `test:receivable-reversal-consumers-sql` e `test:receivable-return-approval-sql` usam PostgreSQL descartável com dados fictícios. Verificam unicidade do recebimento vigente, preservação do livro original, novos atendimentos e recebimentos depois do estorno, aprovação individual, concorrência, permissões, repetição e rollback. A limpeza e recuperação administrativa incluem os registros de estorno, vínculos ativos, aprovações e consumos.

Nesta entrega passaram 50 verificações SQL, 230 cenários de navegador, 396 testes Node e a compilação TypeScript/Vite. A prévia local com 991 títulos e um retorno levou aproximadamente 2,2 segundos; esse resultado não mede o ambiente de produção. Os testes não importaram arquivos nem estornaram recebimentos de produção.
