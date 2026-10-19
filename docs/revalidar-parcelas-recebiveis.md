# Revalidar parcelas de Contas a Receber — 0.14.2

O aviso “Confirme se esta linha é uma nova parcela ou uma alteração de vencimento de um título existente” indica que já há título com o mesmo cliente, filial e documento, mas sem vínculo salvo para aquele vencimento. A ausência de um código único de parcela no relatório exige confirmar qual parcela corresponde à linha. A Central não escolhe pelo número da nota nem pelo valor recebido.

## Conferir e validar as escolhas

1. Na seção **Conferir parcelas do mesmo documento**, confira as linhas indicadas.
2. Escolha a parcela existente quando for o mesmo título; escolha **Nova parcela** somente quando for outra parcela do documento.
3. Clique em **Validar escolhas de parcelas**, junto à tabela de vínculos. O botão reanalisa o mesmo arquivo e não conclui a importação.
4. Confira a nova análise e só então confirme a importação pelo botão correspondente ao relatório de abertos ou quitados.

Após alterar escolhas, o diagnóstico anterior fica identificado como **Análise anterior**. Ele só é substituído quando a nova análise termina. A conclusão permanece bloqueada durante essa conferência. A escolha só se torna permanente depois da importação confirmada; o mesmo cliente, filial, documento e vencimento poderá usar o vínculo salvo nas próximas importações. Um novo vencimento ainda não vinculado pode exigir conferência novamente.

## Quando a função não aplicar o vínculo enviado

Se a própria análise enviar uma escolha explícita e a resposta continuar tratando aquela linha como ambígua, a versão 0.14.2 informa **“A função de importação não aplicou os vínculos selecionados”**. O arquivo e as escolhas são preservados; o sistema não libera a importação nem presume outra parcela. Um conflito financeiro legítimo conserva sua mensagem original.

O agente não consegue republicar a função no Supabase sem acesso administrativo ao projeto. Para sincronizar a função existente com o código atual:

1. Abra **Supabase → Edge Functions → receivables-import → Code → index.ts**.
2. Abra o [código completo da função no repositório](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/receivables-import.ts), clique em **Raw** e copie o arquivo inteiro.
3. Substitua o conteúdo de `index.ts` e publique a atualização da função existente.
4. Na Central, confira a versão 0.14.2, escolha as parcelas corretas e valide as escolhas novamente.

Esse arquivo TypeScript pertence ao editor da Edge Function. Para essa melhoria não há SQL novo, nova função ou limpeza de dados. O código atual da função já encaminha os vínculos à prévia e à confirmação; sua republicação é necessária somente quando a função publicada estiver desatualizada ou divergente. Se o aviso persistir, preserve a seleção e informe a versão exibida e as linhas afetadas para comparar a resposta efetiva da prévia.

## Limite da verificação

O código atual de SQL e gateway foi ensaiado localmente com 35 títulos sintéticos e as seis posições da imagem. Os vínculos explícitos resolveram as seis ambiguidades. Isso comprova o fluxo local, mas não identifica qual versão de função está publicada no projeto do usuário nem confirma uma importação de produção. Nenhuma proteção de identidade, recebimento, carteira ou histórico foi removida.
