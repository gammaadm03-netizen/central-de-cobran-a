# Ativar Caixa em Importar Bases, Contas a Receber e Cobrança — 0.4.0

**Atualização posterior:** o usuário confirmou a execução do SQL desta página. Para ampliar o cadastro a 17 posições, seguir [ativacao-contas-caixas.md](ativacao-contas-caixas.md) e executar somente 012; não repetir 008/009/010/011. A publicação de `receivables-import` continua sendo uma etapa separada para quem ainda não a realizou. As referências a onze contas abaixo registram o escopo original da versão 0.4.0.

Esta atualização acrescenta o preenchimento das onze contas dentro de **Importar Bases → Caixa / Bancos**, a importação de Contas a Receber e a operação de Cobrança com validação financeira. O endereço da Central continua sendo https://central-de-cobran-a.pages.dev.

O usuário informou que o login, o Painel, os saldos das onze contas e a importação de Contas a Pagar já funcionam. Esses dados devem ser preservados. Esta página descreve a próxima ativação; os testes locais não comprovam que ela já foi executada no Supabase ou publicada na Cloudflare.

## 1. Atualizar somente a parte nova do banco

Abra o [SQL Editor do projeto atual](https://supabase.com/dashboard/project/sjimddcqgrsauzvffcol/sql/new).

1. Abra o [arquivo de atualização](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/ativar-recebiveis.sql).
2. Copie todo o código para uma **nova consulta** no SQL Editor.
3. Clique em **Run** uma única vez.
4. Confira se o resultado informa **Success. No rows returned**.

O arquivo reúne as migrations **008, 009, 010 e 011** em uma transação. Acrescenta recebíveis, cobrança, validações, posição bancária em lote, arquivos de apoio e indicadores. Preserva usuários, permissões existentes, saldos, títulos de CP, mensagens e auditoria. Não redefine senhas e não contém valores financeiros de demonstração.

**Não executar novamente** 001, 003, 004, `ativar-financeiro.sql` ou as migrations 005/006/007 neste projeto já configurado. Não executar o arquivo combinado e depois as suas quatro migrations individuais. Se uma das migrations novas já foi aplicada separadamente, conferir quais faltam antes de prosseguir. Em caso de erro, investigar a mensagem; não apagar tabelas nem usar reset.

## 2. Criar somente o serviço de importação de recebíveis

1. No Supabase, abra **Edge Functions → Deploy a new function → Via Editor**.
2. Abra o [código do serviço](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/receivables-import.ts) e copie todo o conteúdo.
3. No editor do Supabase, selecione **index.ts** e substitua o conteúdo pelo código copiado.
4. No campo **Function name**, na parte inferior direita, ao lado de **Deploy function**, coloque exatamente **receivables-import**. Substitua qualquer nome automático.
5. Clique em **Deploy function**.
6. Abra **Settings**, desative **Verify JWT with legacy secret** e clique em **Save changes**.

Ao terminar, os serviços utilizados são **auth-gateway**, **payables-import** e **receivables-import**. Preserve os dois primeiros; não é necessário recriá-los. Uma função com nome automático não substitui `receivables-import`.

O secret já configurado **ALLOWED_ORIGINS** deve continuar com `https://central-de-cobran-a.pages.dev`, sem barra no final. As chaves privadas são fornecidas pelo runtime do Supabase; não cole chaves, senhas ou tokens no código ou no chat.

A verificação JWT legada fica desativada porque o próprio serviço confirma o token no Supabase Auth e verifica a sessão aprovada e as permissões oficiais antes de analisar ou gravar. RLS permanece ativa. **Caixa / Bancos utiliza funções do banco e não precisa de outra Edge Function.** Nenhum serviço pago é ativado por esta atualização.

## 3. Conferir a atualização do site

Na Cloudflare, aguarde o deploy da branch `main` terminar. Abra a Central e confira **Versão 0.4.0** no rodapé. Se necessário, pressione **Ctrl + Shift + R** e entre novamente. Publicar o site não executa o SQL nem publica a função do Supabase.

Antes de lançar novos dados, confirme que os saldos e CP já cadastrados continuam disponíveis. Não reimporte a mesma base só para testar preservação; arquivos repetidos são bloqueados.

## 4. Informar os bancos em Importar Bases

Entre como Gerência Geral e abra **Importar Bases → Caixa / Bancos**.

1. Escolha a **Data da posição**.
2. Preencha o saldo de cada uma das onze contas na própria tabela. São aceitos valores positivos, negativos e zero, com até duas casas decimais.
3. Confira **SALDO ACUMULADO INFORMADO** e a quantidade de contas preenchidas.
4. Informe a **Observação da posição** com a origem da conferência.
5. Clique em **Salvar posição de caixa** e confirme a data e o total.

Todas as contas são salvas juntas. Se houver erro ou outra pessoa tiver alterado uma das posições desde a leitura, nenhum saldo desse envio é gravado. Atualize a posição e confira antes de repetir. A auditoria e os registros anteriores são mantidos.

Campo vazio significa **saldo não informado**, nunca zero. Informe `0,00` somente para uma conta cujo saldo real seja zero. O formulário preenche automaticamente apenas os valores já salvos para a própria data selecionada; posições de dias anteriores ficam como referência e precisam ser conferidas para a nova data. Datas futuras são recusadas.

As contas oficiais são: F2G/Bradesco; EASY CLEAN/Bradesco e Banco do Brasil; FAST CLEAN/Bradesco e Banco do Brasil; ECOPLAST/Bradesco e Banco do Brasil; GAMMA/Bradesco; LIMPE FÁCIL/Bradesco e Cora; MY CLEAN/Cora.

Em **Extrato bancário / apoio de conciliação**, é possível registrar um arquivo de até **2 MiB**, com data de referência, descrição e conta opcional. São aceitos `.xlsx`, `.xlsm`, `.xls`, `.csv`, `.ofx` e `.pdf`. Uma cópia original é guardada privadamente, com hash, histórico e auditoria, para download autorizado. **O arquivo é apenas apoio: não preenche saldos, não baixa títulos e não executa conciliação automática.** Os saldos continuam sendo informados na tabela.

A aba **Caixa / Bancos** permanece disponível para consulta dos saldos, subtotais, consolidado e histórico conforme as permissões. A entrada centralizada das onze contas fica em Importar Bases.

## 5. Importar o relatório completo de Contas a Receber

Na Gerência ou no acesso de Contas a Receber, abra **Importar Bases → Contas a Receber**.

1. Selecione o relatório **completo do Grupo consolidado, com todas as filiais e sem filtros**.
2. Marque a confirmação de relatório completo e clique em **Analisar arquivo**.
3. Confira a quantidade, o valor do relatório, os títulos novos, os mantidos e as **novas ausências aguardando validação**.
4. Se houver erros, corrija a cópia de importação e analise novamente. Nenhuma linha é importada parcialmente.
5. Clique em **Concluir importação completa de CR** e confirme a comparação.
6. Consulte o histórico do lote e os títulos em **Contas a Receber**.

Colunas obrigatórias: **Documento / NF**, **Cliente / Órgão**, **Filial**, **Vencimento** e **Valor**. Colunas opcionais: **Emissão** e **CNPJ**. Quando informado, o CNPJ deve ter exatamente 14 dígitos, com ou sem pontuação; não completar zeros nem inventar um documento ausente. Datas devem ser civis e os valores não podem exigir arredondamento.

Limites: **2 MiB**, **5.000 títulos**, **100 colunas** e uma única aba preenchida. São aceitos `.xlsx`, `.xlsm` e `.csv` UTF-8. Para `.xls` antigo, salve uma cópia como `.xlsx`. Fórmulas são recusadas; salve uma cópia somente com valores. Macros não são executadas. O original não é modificado; uma cópia é arquivada privadamente com o lote. O navegador faz a conferência inicial, mas o serviço analisa o arquivo novamente e deriva as linhas que o banco pode aceitar.

Arquivo repetido, base vazia, cabeçalho ausente, valor inválido ou mudança da base após a análise bloqueiam a conclusão. Se a identificação do mesmo cliente alternar entre nome sem CNPJ e CNPJ, a importação exige conferência administrativa para evitar dívida duplicada. Não há junção automática de clientes nem redistribuição presumida de carteira.

Um título que desapareceu recebe **QUITADO — AGUARDANDO VALIDAÇÃO**. Isso não comprova recebimento e não gera comissão. A importação mantém a cobradora e o histórico. Ausências já existentes não são encaminhadas novamente como novas a cada importação; um pagamento marcado como não localizado continua em cobrança. Um título já validado que reaparecer no arquivo permanece validado, com alerta na conferência.

## 6. Configurar e operar as carteiras

Na **Administração**, a Gerência deve vincular explicitamente cada login de cobrança à pessoa responsável. Não existe associação automática de `Cobranca01` ou `Cobranca02` a Crislayne ou Emanuelle.

Contas a Receber escolhe a cobradora dos títulos ainda sem responsável. Um novo título do mesmo cliente herda a cobradora da dívida ativa já atribuída. A regra não redistribui carteiras por conta própria. Cada cobradora acessa somente os próprios títulos; a autorização também é aplicada no banco.

A cobradora pode registrar contato, observação, retorno, próxima ação e pagamento informado. Ao escolher **Título pago**, precisa informar a data do pagamento. O título permanece na carteira e aguarda validação financeira.

Na fila de validação de **Contas a Receber**, o responsável confere a data real e escolhe:

- **Confirmar:** registra o recebimento validado, a data real, o atraso na data do recebimento, a cobradora e a origem. O título sai da carteira ativa.
- **Não localizado:** retorna o título à **mesma cobradora**, com próxima ação de cobrar novamente. Não confirma recebimento nem gera comissão. Se ainda não houver cobradora, é necessário atribuí-la antes da devolução; o sistema bloqueia uma devolução sem responsável.

O valor recebido na semana considera somente recebimentos validados, de origem **IMPORTAÇÃO DIÁRIA**, com data real dentro da semana selecionada, de sábado a sexta. Pagamento apenas informado pela cobradora não entra nesse total. Os registros de validação preservam a origem e os dados necessários à futura apuração; **o módulo de comissões ainda não calcula comissões nesta versão**.

## 7. Conferir o Painel e as permissões

Atualize o Painel após gravar saldos ou importar bases. Recebíveis, obrigações e recebimentos seguem o período selecionado. O caixa mostrado é a posição atual disponível na data oficial de São Paulo; trocar para uma semana antiga não transforma o caixa atual em posição histórica. O caixa projetado utiliza caixa, títulos a receber e títulos a pagar do período, somente quando as fontes necessárias estão disponíveis. Projeção não é confirmação de dinheiro recebido.

Confira os totais com as fontes reais. Consulte a auditoria como Gerência. Teste com os acessos de cada função: Diretor somente consulta, CR não altera CP, CP não importa CR e cada cobradora enxerga apenas sua carteira. Teste também acesso externo e permanência dos dados após atualizar a página ou publicar nova versão. A execução dos testes locais está descrita em [estado-verificacao.md](estado-verificacao.md); ela não substitui essa conferência remota.

## O que continua pendente

Fechamento/Faturamento, Margens, Comissões de vendedores e cobradoras, RH/DP, previsões completas de CP, relatórios Excel detalhados de CP, conciliação bancária, backups operacionais e migração conferida do estado atual da Central antiga continuam em implantação. Criação completa de contas Auth, redefinição administrativa e troca obrigatória também exigem conclusão. Estoque ou outras fontes ausentes permanecem pendentes, sem assumir zero. A primeira versão completa de produção ainda depende da implementação e homologação desses itens.
