# Central Financeira — Grupo Ecoplast

Versão de desenvolvimento **0.18.14**. As quatro abas restantes da V75 — Comissões, Faturamento, Margens e RH/DP — foram adaptadas à base central. O estoque permanece manual em Importar Bases. A ativação do Supabase e a conferência das bases reais continuam necessárias.

## Conciliação diária de títulos e cheques — 0.18.14

Selecionar o relatório completo da manhã inicia a conferência de Contas a Pagar. A confirmação aplica inclusões, atualizações e os pagamentos dos títulos ausentes: títulos comuns na data do vencimento e cheques na data oficial da importação. Cada fluxo mantém sua própria posição; a primeira carga de cheques estabelece a referência. Marcadores de R$ 0,01 exigem confirmação individual sem gerar realizado. Contas já vinculadas são reaproveitadas; exceções permanecem visíveis. Reenvios, correções posteriores e histórico são protegidos pelo protocolo da importação. [Ativar o SQL 058, atualizar payables-import e usar a rotina diária](docs/conciliacao-diaria-contas-pagar.md).

## Aprovação de retorno na importação de recebíveis — 0.18.13

Títulos quitados ou retirados do relatório anterior exigem aprovação individual da Gerência para voltar à carteira. A conferência apresenta a parcela, o recebimento existente e a justificativa do retorno. Aprovar registra a decisão; somente confirmar a importação aplica o retorno e eventual estorno, na mesma transação. Os registros originais e as apurações salvas permanecem no histórico. [Ativação do SQL 057 e rotina de conciliação](docs/conciliacao-retornos-recebiveis.md).

## Confirmação financeira das pendências de comissões — 0.18.12

Títulos trabalhados retirados pelo relatório completo também podem ter o recebimento confirmado em **Contas a Receber → Validação financeira**. A confirmação grava a data e o valor efetivamente recebidos, retira o título das pendências e o disponibiliza na base de comissão do mês do recebimento, conforme as regras vigentes. O histórico e a retirada pelo relatório são preservados. A importação de Quitados continua disponível. [Ativação e rotina de conferência](docs/validacao-financeira-recebiveis.md).

## Novos status do atendimento de cobrança — 0.18.11

O atendimento e o filtro de status incluem **Mercadoria a recolher**, **Nota a cancelar**, **Aguardando nota assinada**, **Nota com pendência** e **Pausar cobrança**. O andamento e as finalizações preservam o status no histórico; para finalizar, continuam obrigatórias observação, próxima ação e data de retorno. São classificações operacionais: pagamentos, cancelamentos de notas e baixas seguem seus procedimentos próprios. [Ativar o SQL 054 e utilizar os status](docs/status-atendimento-cobranca.md). A atualização não exige alteração de Edge Function.

## Bancos de pagamentos e Caixa Interno — 0.18.7

Correspondências privadas entre a descrição bancária do relatório e uma conta oficial ativa permitem preencher o banco automaticamente em qualquer filial. Os identificadores conferidos são preservados até a confirmação. Caixa Interno, com qualquer valor, exige baixa administrativa individual e não gera pagamento ou realizado; o marcador de R$ 0,01 mantém sua confirmação própria. Arquivo, valor nominal, vencimento e histórico permanecem preservados. [Ativação do SQL 050 configurado e da função payables-import](docs/pagamentos-bancos-caixa-interno.md). Números reais das contas ficam fora do código público.

## Data efetiva nos pagamentos de Contas a Pagar — 0.18.6

O relatório de pagamentos utiliza **Quitação: data do pagamento** quando presente, preservando o vencimento da previsão. Relatórios antigos sem essa coluna mantêm a leitura anterior. Quitação vazia, inválida ou futura é identificada pela linha, antes de consultar ou gravar dados financeiros, com validação independente no servidor pelo dia de São Paulo. O arquivo original e as regras de baixa individual de R$ 0,01 são preservados. [Atualizar a função payables-import e conferir o relatório](docs/pagamentos-data-quitacao.md). Não exige SQL novo.

## Estatísticas da conferência de contatos — 0.18.5

Quando um arquivo grande de descrições já estava preparado e os contatos eram recebidos depois, estatísticas anteriores podiam estimar apenas uma linha do novo arquivo e causar comparações repetidas entre milhares de registros. O SQL 049 atualiza somente as estatísticas da coluna de identificação do arquivo antes da primeira análise, preserva o reaproveitamento das conferências seguintes e evita calcular chaves de descrições ao conferir contatos. Os limites de tempo e as regras de publicação permanecem iguais. [Ativar o complemento 049 e retomar os arquivos preparados](docs/conferencia-contatos-descricoes.md#complemento-049--versão-0185). A função collection-reference-import já atualizada não precisa ser publicada novamente.

## Conferência de contatos e descrições — 0.18.4

A análise usa as chaves já preparadas, elimina consultas repetidas dos canais de contato e reaproveita a classificação enquanto as revisões financeira e de contatos permanecem iguais. Os arquivos preparados continuam disponíveis pelo histórico. O gateway aguarda até 50 segundos, o site até 60 segundos, e falhas mostram um código seguro para suporte. Uma confirmação incerta mantém o mesmo protocolo; a conferência oficial continua obrigatória antes de publicar. [Ativar o SQL 048, atualizar a função collection-reference-import e retomar os arquivos](docs/conferencia-contatos-descricoes.md). A publicação no Git não instala o SQL ou a função no Supabase.

## Fechamento: dashboards e menu lateral recolhível — 0.18.2

O botão lateral **Fechamento** abre seus dashboards e expande as opções **Margens** e **Custos** logo abaixo. Um novo clique recolhe essas opções. O dashboard consolida todos os itens do mês, com indicadores e distribuição de venda e margem por filial e centro de custo; valida a mesma versão durante a consulta. Margens mantém a análise do fechamento por mês e item. Custos permite consultar o catálogo, buscar produtos e comparar versões por data de referência. Importação e aplicação de custos ao fechamento continuam restritas às permissões existentes; a Diretoria consulta sem alterar. Importar Bases → Custos permanece disponível para os operadores autorizados. A reorganização não exige uma nova migração SQL.

## Carga inicial de Contas a Receber com cobradoras — 0.18.3

A coluna opcional **COBRADORA** preenche a escolha dos clientes ainda sem carteira quando corresponde exatamente a uma única cobradora ativa, ignorando diferenças de acentos, caixa e espaços. A prévia consulta primeiro as carteiras oficiais, preserva vínculos existentes e exige conferência para nomes desconhecidos ou ambíguos. A confirmação usa as escolhas e o arquivo original conferidos. Os relatórios seguintes sem a coluna mantêm a atribuição na Central para clientes novos. [Como importar a carga inicial](docs/receber-carga-inicial-cobradoras.md). O ajuste usa os contratos 030/047 já existentes, sem nova migração SQL.

## Preparar a carga oficial: limpeza administrativa das bases de teste

[Procedimento e SQLs completos](docs/zerar-bases-teste.md) para uma limpeza única autorizada, com cópia privada antes de remover dados e históricos operacionais, mantendo usuários, permissões e configurações. A repetição do mesmo SQL não limpa novas importações oficiais. Não é migration: publicar o site não executa a limpeza. A recuperação é separada e recusa sobrepor novos dados. Validação local: `npm run test:base-reset-sql`.

## Treinamento completo por área

[Guia ilustrado, caminhos e capturas de todas as áreas](docs/treinamento/README.md), com versão navegável e PDF. As telas utilizam dados fictícios de treinamento.

## Relatório completo de Contas a Receber — 0.18.0

A importação completa retira os títulos ausentes da carteira ativa, preservando o histórico. Os trabalhados ficam pendentes em Comissões até Quitados confirmar data e valor reais; ausências nunca geram recebimentos ou comissões. Arquivos parciais usam inclusão/atualização. A leitura também identifica documentos inválidos pela linha e célula. [Ativação do SQL 047 e da função receivables-import](docs/recebiveis-relatorio-completo.md).

## Acesso individual às importações — 0.17.1

Uma concessão privada e auditada permite habilitar as nove áreas de Importar Bases para uma conta de Contas a Receber, com as permissões operacionais necessárias, sem alterar a role nem a matriz de outros usuários. Diretoria, limites individuais de CP e administração permanecem protegidos. [Instalação, configuração por login e revogação](docs/acesso-importacoes-usuario.md). Nenhuma conta real é habilitada pelo código publicado.

## Custos por item e recálculo do fechamento — 0.17.0

Importar Bases → Custos recebe o catálogo por código, preserva custos unitários com até seis casas decimais e exige escolha de linha para custos divergentes do mesmo produto. O original e as versões ficam no histórico. Uma prévia separada permite aplicar a base ao mês escolhido: CMV = custo unitário × quantidade; a margem mantém os demais componentes do fechamento. A confirmação cria uma versão mensal derivada e preserva a fonte anterior. Custos ausentes ou zerados, quantidade inválida e informações incompletas bloqueiam o recálculo.

Ativação: [SQL combinado 044/045, função business-import existente e site 0.17.0](docs/custos-fechamento.md). Publicar código não executa SQL, importa a planilha ou recalcula dados remotos.

## Conciliação durante a importação de Contas a Pagar — 0.16.0

A previsão distingue relatório completo de inclusões e atualizações. No completo, os títulos ausentes exigem escolha individual entre pagamento com data, valor e conta efetivos ou baixa administrativa sem pagamento. Títulos indicados por R$ 0,01 exigem confirmação individual nos fluxos de previsão e pagamentos, sem seleção global e sem converter a baixa em realizado. Arquivo e escolhas são aplicados atomicamente; confirmação incerta mantém o mesmo protocolo para consulta segura.

Baixas aparecem como **BAIXADO SEM PAGAMENTO**, com auditoria e valor original preservados, fora dos valores financeiros e dos totais de Excel. Reaparecimento com valor real exige reabertura explícita. Pagamentos reais anteriores permanecem até estorno justificado. Ativação: [combinado SQL 042/043, função payables-import existente e site 0.16.0](docs/conciliacao-importacao-cp.md), independente das atualizações 040/041. O código publicado não aplica o SQL nem confirma importações remotas.

## Análise de Contas a Receber e revalidação — 0.15.0

A busca de parcelas existentes recebe filtros que usam o índice já instalado, mantendo a comparação exata de identidade. A função tem um orçamento de até 50 segundos e o site espera até 60 segundos pela resposta. Falhas mostram uma referência segura para suporte; uma reanálise interrompida preserva escolhas corretas e mantém a confirmação bloqueada até a nova prévia válida. Esses limites não substituem o tempo de execução do próprio banco.

Ativação: executar o [SQL 041](supabase/dashboard/ativar-otimizacao-importacao-recebiveis.sql), atualizar o código completo da função **receivables-import existente** e conferir o site **0.15.0**, seguindo o [guia de importação e revalidação](docs/revalidar-parcelas-recebiveis.md). A atualização de e-mail 040 é independente. As verificações locais não comprovam ativação remota ou conclusão de uma importação real.

## Rascunho de e-mail após atendimento — 0.15.0

Após finalizar o atendimento, a cobradora pode preparar uma mensagem com todos os títulos pendentes do cliente na mesma carteira, separando vencidos e a vencer, e selecionar os destinatários entre os contatos salvos. A mensagem abre por clique no Gmail, Outlook web ou aplicativo padrão; copiar, baixar texto e baixar `.eml` preservam o conteúdo completo quando ele excede o limite dos links. O envio e sua confirmação ocorrem no aplicativo de e-mail, sem SMTP ou envio automático pela Central.

A fila de opções de rascunho fica somente na memória do módulo Cobrança e termina ao sair dele ou recarregar a página. A finalização registrada no banco permanece preservada. Diretoria segue em consulta. Ativação: somente o [SQL 040 e o site 0.15.0](docs/cobranca-email-rascunho.md), sem nova Edge Function. O Git não aplica o SQL remoto.

## Limite individual para Contas a Pagar — SQL 039

A configuração opcional mantém uma pessoa somente em Painel Gerencial, Contas a Pagar e Importar Bases, com importação restrita a CP e sem alterar o perfil compartilhado dos demais usuários. O limite é conferido pelo banco e pela navegação existente. [Guia de configuração](docs/limitar-usuario-contas-pagar.md). A ativação não cria usuários nem aplica restrições a uma conta automaticamente.

## Destaque dos cards ao passar o mouse — 0.14.3

Os indicadores do painel e os cards de resumo das demais abas ganham elevação discreta, sombra e destaque na borda ao passar o mouse. Botões dentro dos cards também recebem o destaque ao navegar pelo teclado. Valores e ações são preservados; em telas de toque não há efeito persistente, e a preferência por movimento reduzido elimina o deslocamento. Depende somente do site.

## Revalidar escolhas de parcelas — 0.14.2

A seção de parcelas agora tem **Validar escolhas de parcelas** junto aos vínculos. Ao alterar uma escolha, a tela identifica os problemas como resultado da análise anterior até a revalidação. A confirmação continua separada e exige a prévia oficial sem impedimentos. Se a mesma análise enviar um vínculo explícito e a função devolver aquela linha como ambígua, a tela informa que a função não aplicou a escolha, preserva o arquivo e bloqueia a conclusão. O [guia de revalidação](docs/revalidar-parcelas-recebiveis.md) explica o fluxo e a atualização da função existente quando necessária.

## Diagnóstico da importação de Contas a Receber — 0.14.1

Quando a análise bloqueia um arquivo, o aviso agora mostra imediatamente o primeiro erro com linha, coluna e orientação, seguido da tabela completa. A página traz esse diagnóstico para a área visível e preserva o arquivo selecionado. As regras de títulos, carteiras e recebimentos continuam em vigor. Esta melhoria de apresentação não confirma a causa de um novo arquivo sem analisar seus dados ou o erro específico.

## Identidade mensal e campanhas — 0.14.0

A tela inicial apresenta marca maior, o slogan preservado e o crédito solicitado abaixo da versão. As cores e os símbolos seguem doze campanhas do calendário brasileiro, pelo mês oficial de São Paulo. Outubro Rosa utiliza o laço rosa na entrada e um card compacto com mensagem em todas as abas autorizadas, incluindo Administração. Os temas mudam automaticamente, com renovação ao retornar à página.

Esta atualização depende somente do site. Não exige SQL, atualização de funções ou reimportação. Acesso, permissões e recuperação de senha seguem os fluxos atuais.

## Ativo Circulante com duas casas — 0.13.5

O Ativo Circulante aparece com duas casas decimais no painel, histórico e Excel. O cálculo e os valores preservados continuam exatos. Esta atualização depende apenas do site; não exige SQL, atualização de funções ou reimportação.

## Folha e totais do relatório de RH / DP — 0.13.4

A importação reconhece o modelo de onze colunas com **Salário Folha**, **Salário recebido**, **Total** e o rodapé final. Fórmulas financeiras utilizam somente resultados numéricos já salvos pelo Excel. O rodapé é conferido contra as pessoas, preservado separadamente e não aumenta a contagem do quadro.

O usuário confirmou três indicadores: **Folha total do relatório** (incluindo sócios), **Salários dos colaboradores** e **Pró-labore sem descontos**. O Total de remunerações e benefícios passa a usar a própria coluna **Total** e seu rodapé, substituindo a soma de cinco campos anterior. Prévia, cards e Excel mantêm as mesmas fontes e distinguem colaboradores e sócios.

Ativação: [folha e totais da planilha](docs/corrigir-importacao-rh.md). Executar o combinado **031..038**, atualizar a função existente **business-import**, conferir o site **0.13.4** e reimportar a planilha com a data original para recuperar os campos anteriormente ausentes. A revisão 4 preserva o histórico e é idempotente.

## Quatro abas recuperadas da V75 — 0.13.0

Faturamento e Margens consultam versões mensais do mesmo fechamento, com filtros, detalhes e Excel completo do filtro. RH/DP recupera quadro, folha, cesta e calendário, com os dois campos de salário preservados. Comissões apresenta cobradoras e vendedores, regras com vigência e apurações preservadas. A base da cobrança continua sendo o valor efetivamente recebido e validado em títulos trabalhados.

O usuário confirmou os mínimos de Mateus e Kevyn: **10% em setembro/2026; 14% a partir de 01/10/2026**. A Gerência vincula as pessoas reais às políticas recuperadas; nenhuma carteira ou identidade de login é criada por nome. A Diretoria permanece somente em consulta.

Ativação: [guia das quatro abas](docs/ativacao-demais-abas.md). Executar o combinado repetível **031..034**, publicar a nova função **business-import** e conferir o site **0.13.0**. Importar as bases atuais em **Fechamento / Faturamento** e **RH / DP**. O HTML e os registros embutidos do original não foram incluídos no site nem promovidos à posição atual.

## Diretoria somente para consulta — 0.12.2

O perfil Diretor consulta todas as abas, incluindo a Administração em leitura, e não acessa Importar Bases. Os controles e as funções do banco bloqueiam alterações, validações, importações e envio/alteração de mensagens. A atualização utiliza a migration **031**, separada do combinado de recebíveis. A criação da conta Auth e seu vínculo com o login permanecem no cadastro autorizado; nenhuma senha é incluída no código. [Guia de ativação e cadastro](docs/acesso-diretoria.md).

A correção **0.12.1** mantém Salvar andamento, Finalizar atendimento e Marcar como título pago visíveis para operadores autorizados quando há um título aberto no atendimento. Bloqueios mantêm os controles desabilitados com a explicação correspondente. A seção Gerenciar responsável foi retirada do atendimento; a cobradora aparece somente para consulta, conforme a importação. A correção chega pelo site e utiliza a mesma ativação de banco e importação da 0.12.0.

## Atendimento e responsáveis na importação — 0.12.0

Iniciar, Pausar e Salvar andamento têm estados e motivos de bloqueio explícitos. Finalizar exige atendimento iniciado e registra a próxima ação oficial. Retornos de hoje ou atrasados têm prioridade na própria carteira. Pagamento informado segue à validação de Contas a Receber; não localizado retorna à mesma cobradora com retorno para hoje.

Em Importar Bases, a responsável dos clientes sem carteira é escolhida durante a importação de abertos. Vínculos existentes são preservados nas atualizações diárias. O mesmo arquivo já importado pode completar responsáveis ausentes sem duplicar os títulos. Quitados e recebimentos históricos não são redistribuídos.

Ativação: [guia do atendimento e retornos](docs/cobranca-atendimento-retornos.md). Executar o combinado **022..030**, atualizar a função existente **receivables-import** e conferir o site **0.12.0**. Publicar pelo Git não aplica alterações do Supabase.

## Contatos e descrições na Cobrança — 0.11.0

O atendimento da **Cobrança** recebe contatos compartilhados por órgão, editáveis pelas cobradoras autorizadas, e descrições de contratos vinculadas por cliente, nota e filial. As descrições aparecem somente nessa aba, em títulos vencidos ativos; ficam fora de Contas a Receber, Comissões e quitados. Emails/telefones ausentes permanecem em branco, vários canais são preservados e atualizações manuais têm prioridade sobre a lista inicial. Relatórios acompanham cobertura e alterações.

**Importar Bases → Contatos e descrições** prepara os dois arquivos de apoio em lotes, mantém o original privado e exige prévia/confirmação do servidor. A base de descrições pode abranger abertos vencidos e a vencer, sem criar títulos nem alterar valores financeiros. Conflitos e linhas sem vínculo ficam para conferência. A publicação oficial é transacional.

Ativação: [guia de contatos e descrições](docs/cobranca-contatos-descricoes.md). O combinado atual inclui **022..028**; numa base 0.10.0 instala somente 027/028. Publicar a nova função **collection-reference-import** e o site; não substituir os gateways existentes. Os arquivos enviados no chat não foram importados remotamente pelo agente.

## Central de Cobrança operacional — 0.10.0

A central recupera as quatro abas da versão final da V75: **Visão geral**, **Títulos**, **Validação financeira** e **Tempo de trabalho**. Títulos apresenta lista à esquerda e atendimento ao lado, com busca, filtros, ordenação, status operacional, observação, próxima ação/data e cronômetro. Iniciar/pausar/finalizar persistem no servidor; conclusão, histórico e encerramento do intervalo são atômicos. Rascunhos não confirmam pagamentos. A Diretoria consulta sem escrita; cobradoras acessam a própria carteira e seu tempo. O recebimento continua sendo confirmado pelo financeiro ou pela importação dos quitados.

Ativar com o [guia da Central de Cobrança](docs/central-cobranca-operacao.md): o combinado condicional agora inclui **022..026**; em uma base 0.9.0, instala somente a nova 026. Não exige nova função ou alteração das credenciais. Não há valores/tempos legados presumidos.

## Contas a Receber e Cobrança — 0.9.0

Importação dos dois modelos reais do ERP: **Abertos e vencidos** atualiza a carteira; **Títulos quitados** confirma recebimentos, retira títulos da cobrança ativa e alimenta a base de comissões. Nominal e recebido ficam separados, inclusive diferenças e antecipações. Reimportações são idempotentes e correções preservam versões. Parcela é identificada por filial, cliente, documento e vencimento; valor é atualizável. Mudança ambígua de vencimento exige vínculo explícito, pois a origem não fornece código único da parcela.

Cobrança recupera indicadores, carteira por responsável, faixas, contatos, retornos e próximas ações, limitada aos vencidos pela data oficial de São Paulo. Diretoria vê atraso, total a receber e recebido no dia. Comissões consulta o valor efetivamente recebido por período/responsável, sem taxas ou pagamentos presumidos. Percentuais e vigências ainda precisam de definição. Responsáveis existentes e histórico são preservados; vínculos desconhecidos ficam pendentes.

Ativação dos recebíveis: [guia 0.9.0](docs/ativacao-operacao-recebiveis.md), função existente **receivables-import** e site. O combinado foi ampliado para **022..026** na 0.10.0, preservando versões já aplicadas. Não repetir a instalação inicial; sem dependência de CP021. [Fluxo confirmado e colunas dos relatórios](docs/contas-receber-fluxo.md).

## Contas a Pagar por importação — 0.8.0

A equipe continua lançando no sistema de origem. **Importar Bases → Contas a Pagar** possui duas opções: **Previsões / novos títulos** para a primeira base e atualizações da previsão; **Pagamentos realizados** para o relatório dos títulos efetivamente pagos. O segundo modo registra os dados reais, concilia automaticamente os títulos válidos e evita duplicar pagamentos em reimportações. Títulos ausentes permanecem na base. A rotina informada é segunda-feira para previsões e terça a sexta para pagos; reprocessamento em outros dias é permitido.

O **Contas a Pagar** abre pelo resumo: previsto versus realizado por Macro na semana sábado–sexta, total pago no mês, compromissos a vencer e vencidos. Uma consulta por período e Macro abre os pagamentos pela data efetiva, com acesso individual a cada título. A Diretoria consulta sem permissão de escrita; fechamento, correções excepcionais e previsões de oito semanas ficam disponíveis nas ferramentas de detalhe.

A identidade é **filial + número do lançamento**. Dados fornecidos pelo relatório atualizam o mesmo título com auditoria. No relatório de pagos, conforme confirmação do usuário, `Vencimento: data` representa a data real de pagamento e `Emissão: valor do lançamento` o valor integral pago; o vencimento previsto original é preservado. O campo separado **Cheque: número** mantém zeros à esquerda. Planos e bancos desconhecidos precisam de vínculo oficial uma vez; os vínculos são reutilizados nas importações seguintes.

Ativação: [guia CP](docs/ativacao-contas-pagar.md). O combinado condicional instala somente migrations faltantes **012..021**, preservando dados. Atualizar também a função existente `payables-import` e o site. Publicar código pelo Git não aplica SQL nem publica funções no Supabase. Formato: [modelo do relatório](docs/modelo-importacao-contas-pagar.md).

## O que está implementado

React + TypeScript; login por usuário via gateway no Supabase; recuperação de senha por email com tela própria; RBAC consultado no banco; sessão em memória; logout e revogação; administração de perfis existentes no Auth; vínculo configurável entre login e cobradora; auditoria; mensagens da Diretoria/Gerência. As operações usam RLS e funções autorizadas no servidor.

O Painel preserva a organização e a marca da V75: Hoje/Semana/Mês, semana financeira de sábado a sexta, movimento, alertas e Resumo da Diretoria. Os indicadores disponíveis vêm do banco; fontes ausentes permanecem pendentes. Caixa é a posição atual na data oficial de São Paulo, independente do período escolhido para recebíveis e obrigações. A projeção exige as fontes necessárias e não confirma recebimentos.

**Importar Bases** centraliza as áreas autorizadas. Em **Caixa / Bancos**, a Gerência informa data, saldos das **17 posições: 12 contas bancárias e 5 caixas das empresas**, e observação, confere o consolidado e salva a posição inteira em uma transação. O cadastro segue a lista atualizada do usuário, incluindo Cora Ecoplast e os caixas de Ecoplast, Limpe Fácil, Gamma, Fast Clean e Easy Clean. Zero exige preenchimento explícito; valores de datas anteriores não são copiados automaticamente para um novo dia. Extratos de até 2 MiB são guardados como apoio privado, com hash e auditoria, sem alterar saldos ou conciliar títulos. A consulta de Caixa/Bancos e o estoque de contingência permanecem disponíveis conforme as permissões.

CP possui importação atômica de previsões e pagamentos, classificação obrigatória, histórico preservado, filtros, paginação, CSV e Excel. CR relê o arquivo no servidor. Inclusões/atualizações preservam ausentes; o relatório completo retira ausentes da carteira ativa sem confirmar recebimento, preservando histórico e encaminhando os trabalhados à fila pendente de Comissões. A carteira é herdada da dívida ativa do cliente quando existe uma única atribuição oficial. Identificação ambígua exige conferência, sem união automática. Cobrança oferece carteira individual, contatos, retornos e pagamento informado; a validação manual permanece disponível, e o relatório de quitados confirma os recebimentos automaticamente. Registros validados preservam origem, cobradora e atraso; correções importadas acrescentam versões auditadas. A 0.13.0 acrescenta a apuração versionada das comissões sobre essa base; não registra pagamento de comissão.

As telas e o cálculo de Comissões, Faturamento, Margens e RH/DP estão implementados na 0.13.0 e dependem da ativação e das bases reais descritas acima. Pagamento de comissão, conciliação automática de extratos bancários, migração do estado operacional anterior e backups ainda estão pendentes. Também faltam criação completa de contas Auth, redefinição administrativa e troca obrigatória de senha. Não há valores fictícios nem bases V75 embutidas nos arquivos públicos.

## Atualizar o projeto existente

Para **0.6.0**, aplicar somente `supabase/migrations/013_director_report.sql` após confirmar a atualização 012 das contas. Seguir [docs/ativacao-resumo-diretoria.md](docs/ativacao-resumo-diretoria.md). Não repetir scripts anteriores nem alterar Edge Functions. As posições históricas permanecem intactas; ausência de dados bloqueia o cálculo, sem substituir por zero.

Para **0.5.0**, seguir [docs/estoque-manual.md](docs/estoque-manual.md): atualizar o site e usar o novo card em Importar Bases. O projeto já possui `save_manual_stock` e `current_stock`; esta mudança não exige nova migration nem Edge Function. O rascunho de integração automática foi retirado antes de publicação após a decisão do usuário por entrada manual.

Em **Importar Bases → Estoque**, a Gerência registra valor total, data de referência e observação. A posição alimenta o Painel e Caixa/Bancos a partir da mesma base, com histórico paginado, responsável e auditoria. Uma posição antiga não substitui outra de referência mais recente; ausência continua diferente de zero explícito. Não há integração com o portal interno, conector local ou chave de máquina nesta entrega.

A imagem completa confirmou as descrições e o usuário retirou M49 da fórmula. O Resumo da Diretoria calcula o Ativo Circulante no banco, com impostos do mês passado, 14% do faturamento geral e os demais componentes oficiais. Importar Bases → Resumo da Diretoria recebe os complementos diários conferidos pela Gerência, com auditoria e revisões; caixa, CR, estoque e mercadoria usam as bases centrais. O Excel contém a posição diária e a memória do cálculo. Detalhes: [docs/relatorio-diretoria-mapeamento.md](docs/relatorio-diretoria-mapeamento.md).

O usuário informou que login, Painel, onze saldos e uma base completa de CP já funcionam, e confirmou a execução sem erro da atualização 008/009/010/011. **Preservar esses registros e não repetir a instalação anterior.** Para **0.4.1**, seguir [docs/ativacao-contas-caixas.md](docs/ativacao-contas-caixas.md): executar somente `supabase/migrations/012_treasury_accounts.sql`. As seis novas posições são cadastradas sem saldo; os onze registros e valores existentes são preservados. Não é necessária outra Edge Function para bancos/caixas.

Contas negativas geram alertas de cobertura no mesmo dia no Painel e em Caixa/Bancos. A necessidade de cobertura soma somente os valores negativos, sem compensação com saldos positivos de outras contas; posições antigas solicitam atualização. Os quadros de contas possuem efeito discreto de elevação ao passar o cursor, respeitando redução de movimento.

A ativação de CR descrita em [docs/ativacao-recebiveis.md](docs/ativacao-recebiveis.md) ainda exige a função `receivables-import`; o sucesso do SQL não comprova que essa função já foi publicada. `auth-gateway` e `payables-import` existentes permanecem em uso. Não repetir o arquivo combinado 008/009/010/011 para acrescentar contas.

Não reaplicar 001/003/004/005/006/007 nem `ativar-financeiro.sql` no projeto já configurado. Para um projeto novo, consultar a ordem em [supabase/README.md](supabase/README.md). Deploy do site não executa migrations nem publica funções. Nunca executar reset contra o banco operacional.

## Desenvolvimento

Requisitos: Node 24 e npm 11. Não é necessário criar worktree; cada tarefa cloud já é isolada.

```sh
npm ci --cache /workspace/onboarding-tools/npm-cache --no-audit --no-fund
npm run dev
npm run build
```

`config/supabase.public.json` contém somente URL e chave **publishable**, públicas. O build funciona sem `.env.local`; as duas variáveis públicas da `.env.example` permitem selecionar outro projeto. O Vite rejeita chaves privadas antes de gerar o site. Senhas, chaves administrativas e tokens de provedor não pertencem ao frontend, ao Git ou ao chat.

Sem as funções publicadas, as operações correspondentes ficam indisponíveis. Não existe login de demonstração ou bypass offline. Tokens ficam somente na memória da aba; recarregar ou fechar exige novo login. Os dados oficiais permanecem no banco, sem localStorage como fonte. A sessão tem limite absoluto de doze horas, com perfil revalidado no servidor.

## Verificação

```sh
npm test
npm run test:sql
npm run test:auth-sql
npm run test:director-readonly-sql
npm run test:payables-sql
npm run test:payables-forecast-sql
npm run test:payable-payments-sql
npm run test:payable-identity-sql
npm run test:payable-closing-sql
npm run test:payable-full-payment-sql
npm run test:payable-cheques-sql
npm run test:payables-management-sql
npm run test:payable-paid-import-sql
npm run test:payable-administrative-writeoff-sql
npm run test:payable-forecast-reconciliation-sql
npm run test:payable-paid-reconciliation-sql
npm run bundle:payable-import-reconciliation
npm run bundle:payables-gateway
npm run test:payables-operations-sql
npm run test:treasury-sql
npm run test:director-sql
npm run test:receivables-sql
npm run test:collections-sql
npm run test:collections-overdue-sql
npm run test:receivable-sync-sql
npm run test:receivable-received-import-sql
npm run test:collections-management-sql
npm run test:collection-workbench-sql
npm run test:collection-context-sql
npm run test:collection-reference-imports-sql
npm run test:collection-workflow-sql
npm run test:collection-email-draft-sql
npm run bundle:collection-email
npm run bundle:receivable-import-performance
npm run test:receivable-import-performance-sql
npm run test:receivable-import-collectors-sql
npm run test:receivables-operations-sql
npm run test:bank-import-sql
npm run test:treasury-accounts-sql
npm run test:director-report-sql
npm run test:upgrade-sql
npm run bundle:receivables-gateway
npm run bundle:collection-reference-gateway
npm run test:product-costs-sql
npm run test:product-cost-recalculation-sql
npm run bundle:product-costs
npm run bundle:business-gateway
npm run test:user-import-access-sql
npm run bundle:user-import-access
npm run build
npm run test:browser
```

Os testes SQL usam PostgreSQL local via PGlite e Auth simulado. A suíte 015 preserva a evidência do ledger incremental; a regra operacional mais recente está na 018, que exige pagamento integral e testa a recusa de pagamento parcial na API. Gateway e navegador utilizam serviços sintéticos; não acessam dados financeiros reais. Chromium deste ambiente: `/usr/bin/chromium`, substituível por `CHROMIUM_PATH`. Resultados e limites de verificação estão em [docs/estado-verificacao.md](docs/estado-verificacao.md). Testes locais aprovados não comprovam publicação, entrega de email ou homologação remota.

## Hospedagem e dados anteriores

Frontend estático na Cloudflare Pages e banco/Auth/serviços no Supabase, independentes do PC da empresa. A base local fornece relatórios completos para atualização. A posição operacional antiga ainda precisa ser inventariada e migrada com conferência, sem substituir os saldos e títulos já lançados nem usar números de capturas de tela. Preservar o ZIP original e o estado operacional. Procedimentos: [publicação](docs/publicacao.md), [cadastro atual de contas/caixas](docs/ativacao-contas-caixas.md), [ativação de CR](docs/ativacao-recebiveis.md) e [mapeamento da V75](docs/v75-mapeamento.md).

Nenhum recurso pago é habilitado pelo código. Cotas, pausas e disponibilidade dos planos gratuitos precisam ser conferidas nos provedores. Backup/restauração de produção ainda requerem implantação e teste.
