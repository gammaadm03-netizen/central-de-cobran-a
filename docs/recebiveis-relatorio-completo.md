# Contas a Receber: relatório completo — 0.18.0

A importação de **Abertos e vencidos** passa a oferecer duas abrangências. **Relatório completo** é a opção inicial: contém todas as filiais e todos os títulos abertos da mesma origem, vencidos e a vencer. **Somente inclusão e atualização** preserva os ausentes e deve ser usada para arquivos parciais. A data da posição identifica o relatório; não representa recebimento.

Na análise, confira os títulos presentes, as responsáveis e eventuais vínculos entre parcelas. Confira também os ausentes que sairão da carteira ativa, separados entre trabalhados e sem cobrança. A confirmação aplica as atualizações e as retiradas em uma única transação. Uma análise com erros não pode importar apenas as linhas válidas.

- Ausente com cobrança: sai das filas ativas de Contas a Receber e Cobrança e aparece em **Comissões → Cobradoras → Aguardando confirmação de recebimento**.
- Ausente sem cobrança: sai das filas e dos saldos ativos; permanece no histórico.
- Ausência não confirma pagamento. A fila pendente não soma valores em recebido, comissão ou apuração salva.
- **Títulos quitados** confirma o valor e a data efetivamente recebidos e resolve a pendência. A atualização **0.18.12 / SQL 055** também permite confirmar títulos retirados com movimento de cobrança em **Contas a Receber → Validação financeira**, conferindo a entrada bancária. A comissão continua sujeita às regras de elegibilidade e vigência existentes.
- Desde **0.18.13 / SQL 057**, um título retirado ou quitado que reaparece em abertos exige [aprovação individual da Gerência para retornar](conciliacao-retornos-recebiveis.md). Uma quitação incorreta só é estornada após essa aprovação e a confirmação do arquivo; os registros anteriores são preservados.

A classificação como trabalhado segue a regra já utilizada pela apuração: atendimento iniciado, ação de cobrança ou indicação de que houve cobrança. Nenhum evento, recebimento, data ou valor é inventado a partir de uma ausência. Contatos e histórico de trabalho permanecem preservados. Um intervalo em andamento no título retirado é encerrado com motivo próprio, preservando o tempo decorrido.

O histórico pode ser consultado pelos filtros **Todos, incluindo histórico** e **Ausentes do relatório — histórico**. Títulos retirados não recebem novas ações de cobrança. Para confirmar o recebimento real, importe Quitados ou utilize a fila financeira dos retirados trabalhados após [ativar o SQL 055](validacao-financeira-recebiveis.md).

## Ativação

Requer as atualizações 023, 024, 029, 030, 034 e 041. A instalação verifica esses registros antes de alterar o banco. E-mail (040) e concessão individual de importações (046) continuam opcionais; quando instalados, são preservados.

1. No Supabase, abra **SQL Editor → New query**. Cole o conteúdo completo de [ativar-relatorio-completo-recebiveis.sql](../supabase/dashboard/ativar-relatorio-completo-recebiveis.sql) e execute **Run**. A instalação verifica as dependências e não importa nenhum título.
2. Abra **Edge Functions → receivables-import → Code**. Substitua o conteúdo de `index.ts` pelo conteúdo completo de [receivables-import.ts](../supabase/dashboard/receivables-import.ts). Clique em **Deploy updates**. Esse arquivo é TypeScript; não deve ser executado no SQL Editor.
3. Confira a versão **0.18.0** do site e recarregue. Em Importar Bases → Contas a Receber, escolha **Abertos e vencidos**, informe a abrangência e a data da posição, selecione o arquivo e confirme a declaração. Analise, confira os ausentes e conclua.

Uma função antiga ou banco sem a atualização bloqueia este novo fluxo com orientação de ativação. Clientes antigos conservam o comportamento incremental: não retiram títulos silenciosamente. As permissões individuais de importação e as carteiras existentes são preservadas.

Se uma confirmação perder a resposta, mantenha a tela aberta e clique em **Conferir confirmação pendente**. A Central repete o mesmo protocolo, arquivo e escolhas. Não há novo envio com escolhas diferentes enquanto o resultado estiver incerto. Se a base mudar antes da confirmação, será necessária nova análise.

## Erros da planilha

Documento/NF deve ser texto ou inteiro não negativo. Um valor com centavos na coluna de documento é sinal de dado deslocado; não deve ser transformado em uma NF para contornar a validação. A leitura informa a linha e a célula problemáticas. Fórmulas são recusadas e macros não são executadas.

Os arquivos operacionais e as cópias corrigidas não fazem parte do repositório nem do site público.
