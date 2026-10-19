# Atendimento, retornos e responsáveis — 0.12.1

Esta atualização corrige os controles do atendimento e permite definir a cobradora na importação dos abertos. O site, o banco e a função de importação precisam estar atualizados para liberar o fluxo completo. A publicação pelo Git atualiza somente o site.

A correção **0.12.1** mantém os botões de salvar, finalizar e marcar como pago visíveis para operadores ao abrir um título, inclusive quando há algum bloqueio. Nesse caso, ficam desabilitados e a tela explica o motivo. A seção **Gerenciar responsável** foi retirada do atendimento: a cobradora é exibida somente para consulta, com o vínculo definido na importação. Quem já ativou o banco e a função da **0.12.0** recebe essa correção pela atualização do site.

## 1. Atualizar o banco existente

No Supabase, abrir **SQL Editor → New query** e executar o conteúdo completo de [ativar-recebiveis-operacao.sql](../supabase/dashboard/ativar-recebiveis-operacao.sql).

O combinado inclui **022..030**, aplica somente as versões faltantes e mantém os registros existentes. Numa base 0.11.0 completa, acrescenta somente **029** e **030**. Não repetir a instalação inicial nem executar também as migrations individuais. Não apagar tabelas, usuários ou títulos.

**“Success. No rows returned” indica que o SQL terminou com sucesso.** Não significa que o site ou a função já foram atualizados, nem que um arquivo foi importado.

## 2. Atualizar a função existente de importação

Abrir **Edge Functions → receivables-import → Code → index.ts**. Substituir o código pelo conteúdo completo de [receivables-import.ts](../supabase/dashboard/receivables-import.ts) e clicar em **Deploy updates** ou **Deploy function**, conforme o painel.

Este arquivo é TypeScript: **não colar no SQL Editor**. Atualizar a função **receivables-import** que já existe; não criar outro nome. Manter as demais funções, incluindo **auth-gateway** e **collection-reference-import**.

Se **receivables-import** ainda não aparecer na lista, usar **Deploy a new function → Via Editor**, colar esse mesmo arquivo em **index.ts** e informar exatamente **receivables-import** em **Function name**, na parte inferior junto a **Deploy function**.

Em **Settings**, manter **Verify JWT with legacy secret** desligado. O código confirma o token, a sessão aprovada e a permissão. Manter o secret **ALLOWED_ORIGINS** existente com `https://central-de-cobran-a.pages.dev`, sem barra final. Não é necessário copiar credenciais privadas para o site ou para o chat.

## 3. Definir a responsável na importação

Após o deploy, abrir a Central e conferir **Versão 0.12.1** no rodapé. Atualizar com **Ctrl + Shift + R** se necessário.

1. Entrar como Gerência ou Contas a Receber com permissão de importação.
2. Abrir **Importar Bases → Contas a Receber → Abertos e vencidos**.
3. Selecionar o relatório original, confirmar o tipo e clicar em **Analisar arquivo**.
4. Em **Cobradoras responsáveis pela carteira**, escolher a responsável de cada cliente sem vínculo. É possível aplicar uma cobradora às carteiras ainda sem responsável e ajustar as escolhas individuais antes de confirmar.
5. Clicar novamente em **Analisar arquivo** para conferir as escolhas no servidor. Conferir quantidade, valores e parcelas; então concluir a importação.

O mesmo cliente mantém sua carteira nas importações diárias. A importação não troca uma responsável existente nem redistribui títulos bloqueados. Conflitos precisam ser conferidos pela Gerência. Não há seleção automática de uma pessoa.

Para os títulos já importados sem cobradora, pode ser usado **o mesmo arquivo original**: a atualização completa as atribuições ausentes, sem criar novamente os títulos ou alterar recebimentos. Uma nova alteração da base exige nova análise. Se a confirmação do envio não chegar, manter o mesmo arquivo e as escolhas e usar a conferência do mesmo envio.

As cobradoras precisam estar cadastradas e ativas na Administração, com os logins vinculados à pessoa correta. O relatório de quitados permanece separado: ele não redistribui carteiras.

## 4. Usar o atendimento

Em **Cobrança → Títulos**, abrir um título vencido da carteira autorizada. A responsável aparece preenchida e não precisa ser escolhida a cada atendimento.

- **Iniciar** abre ou retoma o intervalo oficial da pessoa que atende.
- **Pausar** interrompe temporariamente o cronômetro. O atendimento pode ser retomado ou finalizado depois.
- **Salvar andamento** guarda alterações como rascunho, inclusive antes de iniciar ou durante uma pausa. Não encerra atendimento nem confirma recebimento. Só fica disponível quando há alterações válidas.
- **Finalizar atendimento** exige início prévio, observação, próxima ação e data de retorno de hoje em diante. Encerra o tempo e registra a próxima ação oficial de forma conjunta.

Motivos de bloqueio aparecem junto aos controles: responsável ausente, atendimento já em andamento, nenhuma alteração para salvar, retorno prioritário, acesso em leitura ou atualização do banco pendente. Não é necessário retirar permissões para liberar um botão.

Fechar a página não encerra automaticamente o intervalo do servidor. Pausar ou finalizar antes de sair. Um intervalo ainda em andamento reaparece ao entrar; intervalos de títulos que ficaram indisponíveis podem ser encerrados pela recuperação autorizada, preservando o tempo e sem confirmar pagamento.

## 5. Retornos e validação financeira

Ao abrir a Cobrança, o aviso apresenta o total oficial e os primeiros retornos de **hoje ou atrasados**, usando a data de São Paulo. A cobradora precisa atender esses retornos antes de iniciar outro contato de sua carteira. Retornos futuros não impedem atendimentos. Busca e filtros não escondem essa prioridade; salvar um rascunho também não conclui um retorno.

Se o cliente informar pagamento, preencher a **observação** e a **data real do pagamento**, até hoje, e clicar em **Marcar como título pago**. O atendimento precisa ter sido iniciado. O servidor acrescenta a data à observação, encerra o intervalo e envia o título para **Contas a Receber → Validação financeira**. Salvar um rascunho com status pago não produz esse encaminhamento.

Enquanto aguarda validação, o título fica fora da fila ativa de cobrança e disponível para consulta financeira. O financeiro vê o relato original separado de sua decisão:

- **Confirmado:** sai da cobrança e alimenta a base de apuração de comissões. A confirmação manual mantém o valor nominal vigente; a importação dos quitados usa **Quitação: valor recebido**. Percentuais e pagamento de comissão continuam dependendo das regras ainda não definidas.
- **Não localizado:** mantém a mesma responsável e o histórico do relato, retorna à cobrança com **Retomar cobrança** para hoje e permite novo atendimento. Não cria recebimento nem comissão.

As descrições de contratos continuam somente no atendimento de Cobrança. A atualização preserva contatos mantidos manualmente, arquivos privados, valores financeiros e histórico de trabalho já registrado.
