# Estoque manual em Importar Bases — 0.5.0

A orientação mais recente do usuário é informar o estoque manualmente, pois o portal interno não é acessível de fora da rede da empresa. Esta versão acrescenta o card **Estoque** na área central de atualizações. Não publica a integração automática anteriormente estudada.

## Como utilizar

1. Aguarde a atualização da Cloudflare, abra a Central, pressione **Ctrl + Shift + R** e entre como Gerência Geral.
2. Confira **Versão 0.5.0** no rodapé.
3. Abra **Importar Bases → Estoque**.
4. Informe a **data de referência**, o **valor total do estoque** conferido na origem e uma **observação** sobre a posição.
5. Clique em **Salvar posição de estoque** e confirme a data e o valor.
6. Abra o **Painel Gerencial** ou **Caixa / Bancos** para consultar a posição. Quem já estiver com a tela aberta pode atualizá-la.

O dado é central: não precisa preencher novamente em cada módulo. O Painel utiliza a maior data de referência; para a mesma data, utiliza o registro mais recente. Uma posição antiga permanece no histórico e não substitui outra mais atual. Toda inclusão registra responsável, horário, valor e observação na base e na auditoria.

Campo vazio significa estoque não informado. `0,00` só deve ser registrado quando o valor real for zero. A ausência de estoque mantém **ESTOQUE AGUARDANDO ATUALIZAÇÃO**. Valores negativos, mais de duas casas decimais e datas futuras são recusados. O sistema não usa o número de uma captura de tela como carga inicial.

O histórico é paginado e mostra referência, valor, data/hora do registro, responsável e observação. Em caso de falha de gravação, o preenchimento é preservado e a tela orienta conferir o histórico antes de repetir, sem mostrar sucesso incerto.

O Diretor permanece em consulta. Somente a Gerência recebe o formulário e o banco também valida a autorização; esconder o botão não é o controle de segurança. O formulário já existente em Caixa/Bancos continua utilizando a mesma base e agora possui um acesso para o cadastro centralizado.

## Ativação

Para o projeto atual já configurado, basta o deploy do site. O estoque manual usa as tabelas e funções da migration006 já existente. **Não há novo SQL, Edge Function, conector, credencial ou software a instalar.** O banco não é recriado e os saldos/lançamentos/históricos anteriores permanecem preservados.

O script012 das dezessete contas é uma atualização independente. O retorno vazio de `pg_advisory_xact_lock` é normal e isoladamente não confirma execução do arquivo inteiro. Para conferir sem alterar dados:

```sql
SELECT count(*) AS total_posicoes
FROM public.bank_accounts
WHERE enabled = true;
```

O cadastro atualizado tem 17 posições. Se a migration 012 já estiver aplicada, não a executar novamente para ativar o estoque manual.

## Resumo da Diretoria

A posição manual de estoque entra no indicador já existente do Resumo da Diretoria e nos novos snapshots salvos. O relatório completo e a fórmula com referências de células recebidos posteriormente dependem de identificar as descrições do Excel, conforme [relatorio-diretoria-mapeamento.md](relatorio-diretoria-mapeamento.md). Esta mudança não preenche indicadores ausentes nem presume o termo M49.
