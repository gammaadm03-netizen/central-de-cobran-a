# Modelo de importação de Contas a Pagar — 0.7.1

O usuário forneceu a imagem do relatório e confirmou que a coluna E é **Emissão: valor do lançamento**, e que **Filial** e **Situação** também constam no arquivo. O importador agora reconhece esses cabeçalhos sem exigir renomeação ou mudança da ordem das colunas.

| Cabeçalho no relatório | Informação preservada na Central |
| --- | --- |
| Lançamento | Número do lançamento, combinado com a filial para identificação |
| Histórico | Histórico / favorecido |
| Plano cp - Conta: nome | Plano de Contas, vinculado ao Centro de Custo Macro na conferência |
| Plano cc - Conta: nome | Banco / conta informado no título |
| Emissão: valor do lançamento | Valor integral do título, em centavos exatos |
| Emissão: data | Data civil de emissão |
| Vencimento: data | Data civil de vencimento, usada nos filtros e na semana sábado–sexta |
| Filial | Filial explícita da origem |
| Situação | Situação original, incluindo identificação de cheque quando informada |

Datas de emissão e vencimento desses cabeçalhos ERP aceitam `dd/mm/aaaa`, `dd/mm/aaaa hh:mm` e `dd/mm/aaaa hh:mm:ss`, além de datas nativas e números seriais Excel válidos. Horário não desloca o dia por conversão de fuso; a Central usa a data civil informada. O arquivo original, inclusive o horário e as demais informações, permanece preservado com seu hash. Horário ou calendário inválido bloqueia a análise inteira. O parser compartilhado de datas de CR não foi flexibilizado.

A conta da origem não escolhe automaticamente o banco efetivo do pagamento: a conta oficial é informada ao confirmar a quitação integral. A filial não é deduzida do nome do banco. Plano de Contas não vira Macro por suposição; planos novos continuam exigindo classificação. Cabeçalhos financeiros desconhecidos, colunas duplicadas, fórmulas e linhas inválidas bloqueiam a importação, sem gravação parcial.

Em **Importar Bases → Contas a Pagar**, o quadro **Colunas do relatório de Contas a Pagar** explica a correspondência. Depois de **Analisar arquivo**, a prévia exibe os primeiros dez títulos retornados pela análise do servidor: lançamento, histórico, plano, conta, valor, emissão, vencimento, filial e situação. Conferir esses dados, os totais por plano e as contagens antes de concluir. A prévia é limitada para leitura; a conclusão continua incluindo o relatório completo.

O arquivo deve conter todo o grupo, com títulos em aberto e cheques. O leitor percorre todas as linhas presentes no arquivo, inclusive as ocultas no Excel. Um arquivo que já tenha sido exportado incompleto do sistema de origem continua inseguro para comparação; não confirmar uma base parcial como completa.

## Publicar esta correção

1. Atualizar a função existente **payables-import → Code**, substituindo todo o `index.ts` pelo arquivo [supabase/dashboard/payables-import.ts](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/payables-import.ts), e publicar. Manter configurações de autenticação e origens permitidas já existentes.
2. Aguardar o deploy da branch `main` na Cloudflare e conferir **Versão 0.7.1** na Central. O endereço permanece o mesmo.

Não há nova migration nesta correção de formato. A ativação de pagamentos/conferência/fechamento da versão anterior segue [ativacao-contas-pagar.md](ativacao-contas-pagar.md), quando ainda pendente. Os dados, regras de pagamento integral, classificações, permissões e relatórios anteriores não são recriados.

Verificação local: build TypeScript/Vite, **106 testes Node** e **7 testes de navegador de CP** aprovados. Incluem XLSX e CSV sintéticos com os cabeçalhos confirmados, horários válidos/inválidos, precisão de centavos, conta separada de plano, leitura de linha oculta, macro obrigatória, recusa atômica e regressão de CR. O arquivo operacional real ainda não foi recebido neste turno; os testes não comprovam seus totais, a publicação da função ou o término do deploy remoto.
