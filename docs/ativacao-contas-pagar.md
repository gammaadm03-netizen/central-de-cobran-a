# Contas a Pagar — atualização 0.7.0

Esta atualização mantém o endereço da Central, os usuários, os saldos, os títulos e seus históricos. Acrescenta consulta mensal por macro, pagamentos integrais com valor/data/conta efetivos, revisão por título, fechamento mensal versionado, previsões de oito semanas e Excel detalhado. O envio de código pelo Git não executa SQL nem publica funções no Supabase.

O formato de relatório atualizado está em [modelo-importacao-contas-pagar.md](modelo-importacao-contas-pagar.md). A versão 0.7.1 usa o mesmo SQL e a função de importação atualizada.

## Ativar no projeto existente

1. Abra o [SQL de ativação de Contas a Pagar](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/ativar-contas-pagar.sql), clique em **Raw** e copie todo o conteúdo.
2. Abra o [SQL Editor do projeto](https://supabase.com/dashboard/project/sjimddcqgrsauzvffcol/sql/new), cole em uma nova consulta e clique em **Run**. O arquivo confere as migrations já aplicadas e instala somente as que faltam entre 012 e 018, em uma transação. As atualizações 012/013 são dependências para as 17 contas e os indicadores consolidados. Não repetir a instalação inicial, remover tabelas ou executar reset. Se houver erro, preservar a mensagem; nenhuma aplicação parcial deve permanecer.
3. Em **Edge Functions**, abra a função existente **payables-import → Code**. Substitua todo o conteúdo de **index.ts** pelo [arquivo atualizado da função](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/payables-import.ts) e publique a atualização. Não criar outra função com nome automático. Manter **Verify JWT with legacy secret** desativado: o código valida o token, a sessão aprovada e a permissão oficial no servidor. Preservar `ALLOWED_ORIGINS` e as funções de login/CR.
4. Aguarde a publicação da branch `main` na Cloudflare. Abra [a Central](https://central-de-cobran-a.pages.dev), atualize com **Ctrl + Shift + R** e confira **Versão 0.7.1** no rodapé.

O arquivo combinado pode ser executado novamente: migrations registradas são ignoradas. Isso não equivale a repetir os scripts individuais anteriores. Uma instalação parcial sem registro de migration exige análise; o script não presume que pode substituir estruturas existentes. Nenhum serviço pago, nova chave privada ou senha é necessário.

## Rotina diária

Em **Importar Bases → Contas a Pagar**, analisar o relatório completo do grupo, somente em aberto e cheques, sem filtros de filial, período ou fornecedor. Conferir classificação e contagens e confirmar. O título é identificado por filial e número do lançamento; valor, vencimento e banco são dados atualizáveis. Reimportação conserva o UUID, a primeira importação, os pagamentos e o histórico. Números repetidos na mesma filial sem identificação de parcela, ou versões antigas ambíguas, bloqueiam a operação para conferência. O sistema não mescla dívidas automaticamente.

Em **Contas a Pagar**, selecionar **Mês dos títulos** e **Centro de Custo Macro do mês**, depois **Exibir títulos**. A consulta usa o vencimento e inclui o histórico, com paginação. Os filtros adicionais e a opção de limpar continuam disponíveis.

Para conciliar o dia anterior, selecionar a data real no quadro de pagamentos realizados e abrir o título desejado. Conferir o valor integral preenchido pelo sistema, informar a data efetiva, a conta oficial e a observação; confirmar o registro. O valor exibido para pagamento é o valor integral pendente e não permite pagamento parcial. Para um título sem pagamento registrado, corresponde ao valor atualizado do título. Se estiver errado, corrigir o título antes de confirmar. Registros parciais antigos, se existirem, permanecem no histórico; só é permitido completar integralmente o saldo restante, sem gerar outro pagamento parcial. O realizado usa a data de pagamento, não a data de digitação nem o vencimento. A conta da importação não substitui o banco efetivamente informado no pagamento. Não são debitados saldos bancários automaticamente.

A ausência no relatório continua registrada como **Quitado por importação**, mas não inventa valor, data ou banco de pagamento. Sem registro financeiro real, permanece pendente de conciliação. Importar um valor menor que o já pago mantém os pagamentos e sinaliza o excedente para conferência; não gera desconto, juros, crédito bancário ou estorno automático.

## Correção, revisão e fechamento

Cada título mantém o estado **A CONCILIAR** até que seus pagamentos ativos totalizem exatamente o valor atualizado e o responsável confira e confirme a revisão. Pagamento parcial, ausência no relatório ou valor excedente não habilitam **CONCILIADO**. O Diretor consulta; CP e Gerência executam as alterações autorizadas no banco.

Correções de dados ou macro exigem motivo, confirmação e versão atual. O histórico guarda antes/depois e responsável. A correção individual do macro permanece nas próximas importações enquanto o plano do título for o mesmo. Se o plano mudar na fonte, o vínculo individual anterior é encerrado e o novo plano precisa ser conferido; os pagamentos históricos não mudam automaticamente. Valor, vencimento e banco do título continuam sujeitos às atualizações posteriores do relatório oficial. Pagamentos e estornos permanecem imutáveis. Uma correção de macro com pagamentos exige confirmação expressa da reclassificação: a classificação original permanece registrada e uma nova alocação auditada passa a orientar os relatórios atuais. Um relatório de fechamento já salvo conserva sua classificação e seus valores originais.

O mês de vencimento só pode ser fechado quando contém títulos e todos estão totalmente pagos e marcados **CONCILIADO**. O fechamento salva uma posição imutável, com responsável, horário, títulos, pagamentos e totais por macro. Permite gerar o relatório dessa posição. Uma correção, estorno ou importação que afete o conteúdo conferido invalida a revisão e reabre os meses afetados para nova conferência. Uma importação idêntica não desfaz revisões apenas por atualizar o identificador do lote. Versões históricas geradas pelo identificador antigo só ficam fora do fechamento quando estão baixadas, não têm pagamentos ativos e uma importação já estabeleceu outra versão canônica para a mesma filial+número. Continuam visíveis como **VERSÃO ANTERIOR**, sem exigir pagamento duplicado, e ficam preservadas no histórico do fechamento. Sem comprovação dessa substituição, ou havendo pagamentos em outra versão, o sistema exige conferência em vez de ocultar títulos. Fechar novamente gera outra versão; as posições anteriores continuam disponíveis no histórico.

A consulta mensal de títulos segue **vencimento**; o relatório de realizados segue **pagamento efetivo**, inclusive quando o título vence em outro mês. Essa diferença fica identificada no relatório de fechamento e no Excel operacional.

## Previsão e exportação

A previsão apresenta oito semanas de sábado a sexta. Cheques são parte dos títulos reais, sem soma duplicada. Provisões salariais recuperadas da V75: dia 5 salários R$ 46.000 e sócios R$ 33.000; dia 20 adiantamentos R$ 23.000 e sócios R$ 33.000. Esses valores são configurações com vigência, não lançamentos realizados. A Gerência pode corrigi-los com motivo; o vínculo dos planos aos grupos é explícito. Planos não definidos deixam a estimativa pendente, sem duplicar automaticamente previsão e título. O abatimento da provisão usa os títulos nominais do mês; o saldo real a pagar desconta pagamentos confirmados.

**Baixar Excel dos filtros** respeita os filtros e o período do mês selecionado. **Baixar mês completo — lançamento por lançamento** inclui todos os títulos daquele mês, com indicação expressa de que ignora os demais filtros. O arquivo contém detalhe, resumo por macro, comparação com período equivalente anterior, resumo do mês, pagamentos e realizado por macro. Valores são números, datas são datas e pagamentos preservam conta/data/autor. O limite desta versão é 20 mil registros por período; CSV admite até 100 mil títulos filtrados. Alteração concorrente cancela a exportação para evitar um arquivo misturando versões.

## Conferência após ativação

Conferir títulos e saldos preexistentes, importação de dois dias do mesmo lançamento com alteração de valor/data/banco, pagamento integral e recusa de pagamento parcial, consulta mensal por macro, revisão e fechamento. Comparar o realizado com os comprovantes, sem criar pagamentos fictícios no banco operacional. Conferir Diretor sem escrita, CP sem CR e demais perfis sem acesso não autorizado. Os testes locais usam dados sintéticos e não comprovam a aplicação do script, o deploy ou a homologação remota.
