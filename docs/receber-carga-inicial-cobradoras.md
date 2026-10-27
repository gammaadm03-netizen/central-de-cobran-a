# Carga inicial de Contas a Receber com cobradoras

Em **Importar Bases → Contas a Receber → Abertos e vencidos**, a planilha inicial pode conter a coluna opcional **COBRADORA** ou **Cobradora responsável**. A partir da versão 0.18.3, a Central usa essa coluna para sugerir a responsável dos clientes ainda sem carteira.

## Primeira carga

1. Escolha o relatório original com títulos vencidos e a vencer e a coluna COBRADORA preenchida.
2. Selecione a abrangência correta: **Relatório completo** quando o arquivo contiver todos os abertos de todas as filiais da mesma origem. Confira a **Data da posição do relatório**.
3. Marque a confirmação do tipo de arquivo e clique em **Analisar arquivo**.
4. Na conferência **Cobradoras responsáveis pela carteira**, a opção **Usar cobradoras da planilha** vem marcada quando a coluna contém nomes. Confira as escolhas sugeridas e o total dos títulos.
5. Clique em **Concluir importação de abertos e vencidos** e confirme a mensagem da Central. A gravação só está concluída quando a tela informa **Importação concluída**.

O nome da planilha precisa corresponder a uma única cobradora ativa cadastrada na Central. Diferenças de maiúsculas/minúsculas, acentos e espaços são normalizadas; nomes semelhantes ou abreviados não são adivinhados. Um nome ausente, desconhecido ou duplicado no cadastro exige uma escolha na conferência e nova análise.

O vínculo é por cliente e acompanha seus títulos, inclusive os que ainda vão vencer. Se o mesmo cliente tiver nomes de cobradoras diferentes no arquivo, corrija a coluna ou deixe os campos em branco para escolher uma única responsável na Central. Na Cobrança, continuam aparecendo somente os títulos vencidos.

## Próximas importações

Os relatórios seguintes podem vir sem a coluna COBRADORA. As carteiras existentes são preservadas; escolha a responsável na Central apenas para clientes novos ou ainda sem atribuição.

Se um próximo arquivo continuar contendo a coluna e a escolha precisar ser feita na Central, desmarque **Usar cobradoras da planilha**, selecione as responsáveis e analise novamente. Uma escolha feita explicitamente na conferência prevalece sobre a sugestão do arquivo para um cliente ainda sem carteira.

Uma carteira já existente não é transferida para outra cobradora por causa do nome recebido na planilha. A Central mantém a responsável oficial. A coluna em relatórios de **Títulos quitados** também não altera responsáveis.

## Conferência e confirmação

A análise não grava títulos ou carteiras. O arquivo original, seus valores e as escolhas de responsáveis conferidas são mantidos na confirmação. Se a base mudar entre as conferências, a Central exige nova análise. Se a resposta de confirmação ficar pendente, use **Conferir confirmação pendente**, com o mesmo arquivo e protocolo.

O ajuste utiliza os contratos de importação e carteiras já existentes (030/047), sem nova migração SQL e sem exigir nova publicação da função para o preenchimento na tela. O arquivo standalone da função no repositório também foi regenerado para manter o parser compartilhado atualizado, caso seja republicado posteriormente.

A validação de uma planilha ou a publicação da versão do site não comprova que o arquivo foi gravado no Supabase. Essa confirmação depende da importação pela conta autenticada e da mensagem final de sucesso.
