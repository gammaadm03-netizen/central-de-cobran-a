# Tempo do atendimento de cobrança — 0.18.23

Em **Cobrança → Títulos → Abrir**, o contador principal mostra o **Tempo total de trabalho do título**. Ele soma os intervalos registrados no título, inclusive os de outros operadores autorizados. A Gerência e a cobradora responsável consultam o mesmo total para a mesma posição dos dados.

O campo **Seu tempo neste título** mostra somente os intervalos do acesso conectado. Portanto, dois operadores podem ter tempos próprios diferentes. A cobradora responsável pela carteira aparece identificada separadamente.

Os tempos são acumulados, e não a duração somente do último atendimento. **Atualizar detalhe** consulta novamente os registros oficiais. **Iniciar**, **Pausar** e **Finalizar atendimento** continuam controlando apenas o intervalo da própria pessoa, com um atendimento em andamento por acesso. Os retornos devidos mantêm a prioridade obrigatória.

## Ativação

1. Em **Supabase → SQL Editor → New query**, execute todo o [SQL067 completo](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-tempo-total-titulo-cobranca.sql).
2. Atualize a Central com **Ctrl + F5** e confira a versão **0.18.23**.
3. Abra o mesmo título nos perfis autorizados e use **Atualizar detalhe** para comparar o total.

A atualização usa os intervalos existentes, sem regravar os tempos históricos. O total compartilhado fica restrito aos títulos que o acesso pode consultar. O relatório individual de tempo continua atribuindo cada intervalo à pessoa que o registrou. Esta atualização exige somente SQL e a nova interface; as Edge Functions permanecem com o código atual.
