# Preparar e-mail após o atendimento — 0.15.0

Ao concluir um atendimento na **Cobrança**, a cobradora pode preparar um e-mail com os títulos ainda pendentes do mesmo cliente e da mesma carteira. A prévia separa **vencidos** e **a vencer**, informa documento, filial, vencimento, valor e subtotais. A posição usa a data oficial de São Paulo. O texto solicita uma previsão de pagamento e, quando o cliente já pagou, o comprovante para conferência.

Os destinatários vêm dos contatos salvos do órgão. Observações internas, descrições dos contratos e registros de atendimento ficam fora da mensagem. Preparar, copiar ou abrir o rascunho não confirma pagamento nem registra envio.

## Ativar no projeto existente

1. Abra o [SQL completo de ativação](https://raw.githubusercontent.com/gammaadm03-netizen/central-de-cobran-a/main/supabase/dashboard/ativar-rascunho-email-cobranca.sql) e copie todo o arquivo.
2. No Supabase, abra **SQL Editor → New query**, cole o conteúdo e execute **Run**. A atualização é transacional e pode ser repetida; o recarregamento do esquema é solicitado antes do `COMMIT`.
3. Aguarde a publicação do site pelo Git e confira **Versão 0.15.0** no rodapé da Central. Atualize a página se ela ainda exibir a versão anterior.

O arquivo instala somente a atualização **040_collection_email_draft**. Exige a base de Cobrança, quitações **024**, contatos **027** e fluxo de atendimento **029** já ativos. Se o SQL indicar uma dessas dependências ausente, use o [guia do atendimento e retornos](cobranca-atendimento-retornos.md) para completar a base antes de repetir a 040. A configuração opcional de limites individuais **039** é independente.

Esta entrega usa uma consulta autorizada ao banco. Não exige criar ou atualizar Edge Functions, configurar SMTP, cadastrar provedor de e-mail ou fornecer credenciais da caixa postal. Publicar no Git não executa o SQL nem comprova que o site remoto já foi atualizado.

## Usar na Cobrança

1. Abra o título, inicie o atendimento e registre o andamento, a próxima ação e sua data, conforme o fluxo existente. Clique em **Finalizar atendimento**. Somente uma finalização confirmada pelo servidor oferece o rascunho; pausar ou salvar andamento não abre essa opção.
2. No quadro **E-mail após o atendimento**, clique em **Preparar e-mail de cobrança**. A Central consulta novamente os títulos pendentes e os contatos atuais. Um título encaminhado à validação financeira ou já quitado fica fora da lista; os demais títulos pendentes do mesmo cliente e carteira continuam disponíveis.
3. Confira os totais, o assunto e a mensagem. Selecione, entre os contatos salvos, os e-mails que devem receber a cobrança. Para corrigir ou acrescentar um endereço, salve-o nos contatos do órgão e clique em **Atualizar títulos e contatos**. Endereços retirados do cadastro deixam de fazer parte da seleção atualizada.
4. Clique em **Abrir no Gmail**, **Abrir no Outlook** ou **Abrir no aplicativo de e-mail**. Entre na sua caixa postal, confira os destinatários e a mensagem e confirme o envio no próprio aplicativo.

O botão do Outlook abre a versão web. Para o Outlook instalado no computador, use o aplicativo de e-mail padrão ou **Baixar rascunho (.eml)**. A abertura e a edição de arquivos `.eml` dependem da versão e da configuração do aplicativo. Se o arquivo abrir somente para leitura, use **Copiar mensagem** ou **Baixar mensagem (.txt)** e cole o conteúdo em um novo e-mail.

Se não houver e-mail cadastrado, a mensagem permanece disponível para copiar ou baixar em texto; a abertura do aplicativo e o download do `.eml` exigem ao menos um destinatário salvo selecionado. Se não houver títulos pendentes, a Central informa essa situação sem criar uma mensagem de cobrança.

## Mensagens completas e dados atualizados

Links de abertura têm um limite conservador de tamanho. Quando a mensagem o ultrapassa, o botão correspondente fica desabilitado. Nenhum título ou trecho é cortado: **Copiar mensagem**, o arquivo `.txt` e o `.eml` preservam o conteúdo completo. Use essas opções para carteiras maiores.

O rascunho representa a consulta feita ao clicar em Preparar ou Atualizar. Ao alterar contatos ou concluir uma validação no módulo, a tela pede uma nova preparação. Alterações feitas por outra pessoa depois da consulta exigem **Atualizar títulos e contatos** antes da conferência final. O e-mail já aberto em outro aplicativo não é atualizado automaticamente pela Central.

Se houver mais de 5.000 títulos pendentes para o cliente na carteira, a consulta é recusada com uma explicação, sem apresentar uma relação incompleta. A sessão, a permissão, a carteira e a autoria da finalização são conferidas no servidor a cada preparação. A Diretoria permanece somente em consulta e não recebe os controles de preparação.

## Fila temporária e confirmação de envio

Ao finalizar vários atendimentos, as opções de rascunho ficam em uma fila **somente na memória do módulo Cobrança**, inclusive ao alternar suas abas internas. **Fechar rascunho** dispensa o atual e apresenta o próximo. Sair de Cobrança, encerrar a sessão, fechar ou recarregar a página elimina essa fila temporária; ela não é uma caixa de saída persistida. Os atendimentos já finalizados e os dados oficiais continuam no banco.

A Central prepara o conteúdo e abre o aplicativo escolhido por um clique explícito. Ela não envia mensagens em segundo plano, não acompanha a entrega e não marca um título como cobrado por e-mail. A confirmação de envio e a conferência de entrega ocorrem na caixa postal utilizada.

## Gerar o arquivo de ativação

```sh
npm run bundle:collection-email
```

O gerador usa a migration 040 como fonte, mantém uma única transação e inclui `NOTIFY pgrst, 'reload schema'` antes do `COMMIT`. Ele gera o arquivo local; não se conecta ao banco remoto.
