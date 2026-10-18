# Cobrança somente de vencidos — referência da migration022

**Para a entrega atual 0.10.0, seguir [central-cobranca-operacao.md](central-cobranca-operacao.md).** O combinado aplica a022 quando faltar e também as importações, os recebimentos, o resumo e o atendimento da cobrança. Os passos abaixo são referência da022 isolada e não habilitam o fluxo completo.

O Contas a Receber mantém todos os títulos. A cobrança ativa reúne somente os títulos atribuídos e ainda em aberto cujo vencimento é anterior à data atual de São Paulo. Vencimentos de hoje e futuros não aparecem nessa carteira. Diretoria e Financeiro consultam o mesmo recorte na aba Cobrança; Contas a Receber continua com a visão completa.

## Ativar no projeto existente

1. Abra a [migration 022](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/migrations/022_collections_overdue_only.sql), clique em **Raw** e copie o conteúdo completo.
2. No [SQL Editor do projeto](https://supabase.com/dashboard/project/sjimddcqgrsauzvffcol/sql/new), cole em uma consulta nova e execute **Run**. A 022 exige o módulo CR/Cobrança 009 já instalado e não depende da atualização de CP 021. Preserve a mensagem completa se houver erro; não exclua tabelas, perfis, títulos ou históricos para contorná-lo.
3. Aguarde o deploy da branch `main` na Cloudflare e confira **Versão 0.9.0** na Central. Atualize a tela e entre novamente se necessário.

Não repetir a instalação inicial nem o combinado antigo 008/009/010/011. **Não é necessário criar ou atualizar Edge Functions para esta regra.** A migração muda a consulta e a autorização da cobrança; não importa arquivos, confirma pagamentos, troca responsáveis ou calcula comissões. Os registros e permissões financeiras existentes são preservados.

O servidor aplica a data oficial, inclusive se o relógio do computador estiver diferente. Cada consulta recalcula o recorte; um título aberto passa a integrar a cobrança depois de vencido, ao atualizar a tela. Filtros, paginação, limpeza de filtros e exportação continuam limitados aos vencidos. Sem a view nova, a aba informa a ativação pendente e não utiliza uma consulta ampla como alternativa.

Um pagamento informado pela cobradora continua pendente de validação financeira. O histórico de recebimentos já validados fica preservado e pode ser consultado explicitamente. A integração automática do relatório de quitados exige a atualização completa0.9.0: [fluxo confirmado](contas-receber-fluxo.md).
