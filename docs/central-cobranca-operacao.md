# Central de Cobrança — 0.10.0

A imagem enviada pelo usuário e a implementação final da V75 orientam esta atualização. A cobrança é uma central de atendimento com quatro abas: **Visão geral**, **Títulos**, **Validação financeira** e **Tempo de trabalho**. A entrada de títulos e a confirmação dos quitados continuam pelos relatórios do ERP, conforme [as regras de recebíveis](contas-receber-fluxo.md).

## Títulos e atendimento

A lista fica à esquerda e o atendimento selecionado à direita. Buscar considera cliente, documento, status operacional e observação. Os filtros incluem responsável, faixa de atraso e ordenação por atraso/valor. Quantidade e valor correspondem ao filtro inteiro, não somente à página atual. Em telas pequenas, lista e atendimento se organizam verticalmente.

O painel do título reúne responsável, status de cobrança, observação/contato, próxima ação em texto livre, data e cronômetro. O status operacional fica separado do financeiro: escolher uma forma de contato não muda valor, vencimento ou recebimento.

Status recuperados da versão final da V75:

- NOVO TÍTULO - COBRAR
- SEM SUCESSO
- AGUARDANDO RETORNO
- COBRANCA VIA EMAIL
- COBRANCA POR WHATSAPP
- AGUARDANDO LIQUIDACAO
- SEM PRAZO
- SEM PREVISAO DE PG
- PAGAMENTO PROGRAMADO
- TÍTULO PAGO

**Salvar andamento** preserva o rascunho no banco. **Finalizar atendimento** exige responsável e observação; para cobrança comum, exige também próxima ação e data. Para título pago, exige data informada até hoje, sem obrigar agenda de cobrança. Finalizar grava a ação e encerra o intervalo ativo conjuntamente. É permitido finalizar sem ter iniciado o cronômetro, sem inventar tempo trabalhado.

O botão **Marcar como título pago** seleciona o status e solicita a data. A finalização envia o título para validação e remove a agenda de cobrança anterior, preservando-a no histórico; esse registro ainda não confirma recebimento. O arquivo de quitados ou a validação autorizada do financeiro encerra a dívida, preservando o histórico. Pagamento não localizado mantém a mesma responsável e devolve o título à cobrança.

Responsável não é deduzida do usuário que abriu a tela. Atribuição continua sujeita às regras existentes de carteira: a Gerência pode vincular cliente sem responsável, com justificativa; não há redistribuição silenciosa de dívida já atribuída. A Diretoria consulta sem alterações; a cobradora trabalha na própria carteira.

## Tempo de trabalho

**Iniciar**, **Pausar** e **Finalizar** usam horários do servidor e intervalos persistidos no banco. Recarregar a página não zera o acumulado. Uma pessoa possui somente um cronômetro ativo por vez; abrir outro título não cria outro intervalo nem pausa silenciosamente o anterior. Não há corte por inatividade ou fechamento da aba presumido como regra de trabalho.

O atendimento ativo da própria pessoa permanece recuperável mesmo fora dos filtros. Se a origem reagendar o título para uma data futura enquanto o cronômetro estiver rodando, é possível pausá-lo após recarregar a tela, sem liberar acesso à cobrança de títulos a vencer.

O tempo pertence ao usuário que realizou o atendimento, com a responsável da carteira preservada no histórico. O relatório permite consultar período e responsável, apresenta intervalos e exclui pausas. Intervalos que atravessam datas são distribuídos pelos dias correspondentes em São Paulo. Tempos da versão antiga não são inventados ou migrados sem uma base operacional conferida.

Cronômetro e atendimento não alteram saldo bancário, valor recebido, comissão ou permissão. Repetições de comandos são identificadas para evitar duplicação; alterações concorrentes exigem atualização antes de salvar.

## Ativação incremental

1. Abra o [SQL combinado atualizado](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/ativar-recebiveis-operacao.sql), clique em **Raw** e copie tudo.
2. Cole em uma consulta nova no [SQL Editor do projeto](https://supabase.com/dashboard/project/sjimddcqgrsauzvffcol/sql/new) e execute **Run**. Ele aplica somente versões faltantes **022..026**, numa transação, sem refazer usuários, saldos ou títulos. Se a 0.9.0 já foi ativada, somente a nova **026** será instalada. Não executar também as migrations individuais.
3. Aguarde o deploy do site e confira **Versão 0.10.0** no endereço habitual.

A 026 acrescenta estado operacional, intervalos e auditoria de trabalho; preserva as migrations anteriores. Esta atualização não exige nova Edge Function nem mudança de credenciais. Se a função de importação de recebíveis da 0.9.0 ainda não foi atualizada, conclua apenas essa etapa do [guia de recebíveis](ativacao-operacao-recebiveis.md); o novo SQL combinado já inclui as atualizações do banco necessárias.

Enviar código ao Git não executa SQL no Supabase. Conferir o funcionamento e os acessos no projeto real após a ativação. Nenhum título ou tempo fictício é criado no banco operacional.
