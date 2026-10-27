# Pagamentos: bancos oficiais e Caixa Interno — 0.18.7

Em **Importar Bases → Contas a Pagar → Pagamentos realizados**, as descrições de banco e conta cadastradas pela administração apontam para a conta oficial. A mesma descrição tem o mesmo destino em qualquer filial. A conta precisa ser única, ativa e do tipo banco; uma conta ausente, inativa ou duplicada permanece pendente.

As correspondências são mantidas em configuração privada no banco. Números reais de contas não são distribuídos no código público. O texto do relatório, a filial e o arquivo integral permanecem preservados no histórico. O nome oficial aparece na conferência. A conta identificada é conferida novamente e seu identificador acompanha a confirmação, para impedir uma troca silenciosa entre a análise e a importação.

## Caixa Interno e baixas

**CAIXA INTERNO** representa baixa administrativa, com qualquer valor. A tela exige a confirmação individual **Confirmo a baixa deste título de Caixa Interno, sem registrar pagamento**. A baixa preserva o valor nominal e o vencimento originais, retira o título dos valores financeiros e mantém o histórico, sem gerar pagamento, realizado ou débito em conta. A data do pagamento fica vazia, porque não houve pagamento.

O marcador de **R$ 0,01** mantém a confirmação individual existente, inclusive quando o banco é Caixa Interno. Não há confirmação em lote. Uma única escolha pendente bloqueia a conclusão integral do arquivo.

Um título já pago, desconhecido ou com identidade ambígua exige conferência; a importação não inventa a previsão nem apaga pagamentos anteriores para aplicar uma baixa. Uma confirmação repetida preserva o mesmo protocolo. Um arquivo antigo que havia registrado Caixa Interno como pagamento exige revisão do histórico, sem conversão automática.

## Como usar

1. Abra **Importar Bases → Contas a Pagar → Pagamentos realizados**, selecione o arquivo e confirme seu conteúdo.
2. Clique em **Analisar pagamentos**. Confira os nomes oficiais dos bancos identificados. Para descrições sem correspondência cadastrada, escolha a conta e reanalise.
3. Em **Conciliação antes de importar**, confirme separadamente cada baixa de Caixa Interno ou de R$ 0,01.
4. Clique em **Reanalisar mesmo arquivo** e conclua quando não houver pendências. Pagamentos bancários continuam usando a data efetiva de Quitação e os valores do relatório.

## Ativação

Requer as estruturas 012, 042 e 043. Publicar o site não instala SQL ou Edge Functions no Supabase.

1. Baixe o **instalador privado configurado do SQL 050**, entregue à administração nesta conversa. Abra o arquivo completo, copie tudo e execute em **Supabase → SQL Editor → New query → Run**. Ele instala as regras e as correspondências fornecidas, sem importar dados financeiros. O arquivo público [ativar-bancos-baixas-contas-pagar.sql](../supabase/dashboard/ativar-bancos-baixas-contas-pagar.sql) contém somente a estrutura, sem os números reais das contas.
2. Copie o [código completo de payables-import](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/payables-import.ts). Em **Supabase → Edge Functions → payables-import → Code**, substitua todo o conteúdo de **index.ts** e clique em **Deploy updates**.
3. Recarregue a Central até a versão **0.18.7** e reanalise o relatório.

O instalador pode ser executado novamente: preserva dados existentes e atualiza somente as correspondências configuradas. Não compartilhe o instalador configurado no repositório público.

## Manutenção e validação

`npm run test:paid-bank-rules-sql` valida as correspondências e as baixas em PostgreSQL descartável, usando contas fictícias. O comando `npm run bundle:paid-bank-rules` gera a estrutura pública. A administração pode gerar um instalador privado com `node scripts/bundle-paid-bank-rules.mjs --config /caminho/privado/regras.json --output /caminho/privado/ativar.sql`; a configuração usa uma lista de objetos com `source` e `official_name`. O gerador recusa gravar um instalador configurado dentro do repositório.
