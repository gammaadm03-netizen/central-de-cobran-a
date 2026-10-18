# Contas a Pagar — atualização 0.8.0

A operação passa a ser alimentada pelo relatório do sistema de origem: previsão, pagamentos e alterações não precisam ser lançados novamente título por título. O resumo apresenta previsto versus realizado por Macro na semana, total pago mensal, compromissos a vencer e consulta por período com detalhe individual.

## Ativar no projeto existente

1. Abra o [arquivo SQL de ativação](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/ativar-contas-pagar.sql), clique em **Raw** e copie tudo.
2. Abra o [SQL Editor do projeto](https://supabase.com/dashboard/project/sjimddcqgrsauzvffcol/sql/new), cole em uma consulta nova e clique em **Run**. Esse arquivo **.sql é destinado ao SQL Editor**. Aplica somente atualizações faltantes de 012 a 021 numa transação, preservando usuários, saldos, títulos, pagamentos e histórico. Se houver erro, guarde a mensagem completa; não exclua tabelas nem execute reset.
3. Abra **Edge Functions → payables-import → Code**. Substitua todo o conteúdo do **index.ts** pelo [arquivo da função atualizado](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/payables-import.ts) e clique em **Deploy updates**. Esse arquivo **.ts vai no editor da função, nunca no SQL Editor**. Atualize a função existente; não crie outra com nome automático. Preserve `ALLOWED_ORIGINS`, `auth-gateway` e a função CR. Mantenha **Verify JWT with legacy secret** desativado: a própria função valida token, sessão aprovada e permissões no servidor.
4. Aguarde o deploy da branch `main` na Cloudflare. Abra [a Central](https://central-de-cobran-a.pages.dev), atualize com **Ctrl + Shift + R** e confira **Versão 0.8.0** no rodapé.

O combinado pode ser executado novamente: versões já registradas são ignoradas. Uma instalação parcial sem registro exige análise; o arquivo não apaga estruturas para contornar incompatibilidade. Deploy do site não executa SQL nem publica funções. Nenhum serviço pago ou nova credencial é exigido.

## Rotina com os relatórios

Em **Importar Bases → Contas a Pagar**, escolha:

- **Previsões / novos títulos**: primeira base de obrigações e cheques; depois, novos títulos e mudanças da previsão. Rotina informada: segunda-feira. Valor, vencimento, conta, plano, histórico, situação e cheque fornecidos atualizam o mesmo título. Títulos ausentes permanecem na base, sem baixa por ausência.
- **Pagamentos realizados**: relatório contendo somente títulos efetivamente pagos. Rotina informada: terça a sexta. Conforme confirmação do usuário, `Vencimento: data` contém a **data real de pagamento**, `Emissão: valor do lançamento` contém o **valor integral pago**, e `Plano cc - Conta: nome` informa a conta usada. Confirme esse conteúdo antes de analisar.

As opções não bloqueiam outros dias, permitindo reprocessamento e ajustes. O arquivo é analisado novamente pelo servidor; a prévia e a confirmação são por arquivo. Banco/conta e plano desconhecidos precisam de vínculo oficial uma vez, que será reutilizado. Não é necessário abrir e conciliar manualmente cada título válido.

O título é localizado por **filial + número do lançamento**. O relatório de pagamentos mantém seu vencimento previsto, pois a coluna de data agora representa o pagamento. O valor integral informado atualiza o valor atual do título; o anterior permanece na auditoria. Outros dados presentes são atualizados e os ausentes são preservados conforme o [modelo](modelo-importacao-contas-pagar.md). A quitação é integral: não são criados pagamentos parciais, descontos ou juros presumidos.

Pagamento já registrado com os mesmos dados é reutilizado. Repetir o mesmo arquivo de pagamentos não duplica valores. Alterações de pagamento criado por importação geram estorno e novo registro auditados, após a confirmação do arquivo; registros anteriores permanecem. Divergência com pagamento manual, identidade ambígua, título ainda desconhecido ou informação inválida bloqueia o arquivo inteiro e apresenta o que conferir. Para título desconhecido, importe sua previsão primeiro.

O número de cheque é separado do número do lançamento e preserva zeros à esquerda. Um cheque pode estar relacionado a mais de um título; não é usado para identificar ou deduplicar dívidas. Snapshots antigos não recebem um número de cheque deduzido posteriormente.

## Consulta da Diretoria

**Contas a Pagar** abre no resumo. A semana é sábado a sexta, selecionável por uma data. O previsto usa o valor atual dos títulos pelo vencimento previsto; o realizado usa pagamentos ativos pela data real e Macro efetivo. O histórico do valor originalmente importado permanece auditado; o previsto atual não é uma previsão congelada.

O card **Pago no mês** usa o mês selecionado, independentemente da semana. **Consultar pagamentos por período e Macro** lista os pagamentos correspondentes e permite **Abrir título**. A consulta de títulos por vencimento fica em **Abrir todos os lançamentos**; não confundir essas duas datas.

**Tudo a vencer** considera todo o saldo pendente com vencimento a partir de hoje, sem limite de oito semanas; vencidos aparecem separados. Cheques são parte das obrigações, sem somá-los duas vezes. Falta de base é apresentada como pendência, nunca como zero fictício. O Diretor consulta; alterações exigem permissão oficial no banco.

## Exceções, fechamento e relatórios

**Fechamento e parâmetros** reúne fechamento mensal e previsão auxiliar de oito semanas. Pagamentos válidos importados ficam **CONCILIADOS** automaticamente. O fluxo manual permanece para exceções autorizadas, com data, conta, valor integral e auditoria. O mês de vencimento pode fechar quando todos os seus títulos elegíveis estão integralmente pagos e conciliados. Alterações posteriores podem reabrir o mês; fechamentos anteriores permanecem imutáveis.

Correções individuais com motivo e reclassificações de Macro preservam histórico. Uma classificação individual continua enquanto o plano for o mesmo; mudança do plano na origem exige o vínculo correspondente. Versões antigas comprovadamente substituídas permanecem no histórico e não exigem pagamento duplicado. Identidades ambíguas exigem conferência.

Excel e CSV continuam disponíveis nos detalhes. O Excel contém títulos, resumo por Macro, comparação, pagamentos e realizado por Macro; número de cheque é texto. Limites: 20 mil registros por período no Excel e 100 mil títulos no CSV. Mudança concorrente cancela a exportação para evitar mistura de versões.

## Conferir após ativação

Comparar o resumo com o relatório de origem; testar reimportação do mesmo arquivo, mudança de dados do mesmo título, total mensal e consulta por período/Macro. Confirmar leitura sem escrita da Diretoria e a preservação dos dados anteriores. Os testes locais usam dados sintéticos e não comprovam a ativação no Supabase ou os totais dos arquivos operacionais.
