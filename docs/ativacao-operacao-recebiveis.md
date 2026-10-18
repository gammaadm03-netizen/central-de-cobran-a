# Ativar Contas a Receber, Cobrança e base de comissões — 0.9.0

**Atualização 0.10.0:** o SQL combinado foi ampliado para **022..026**, incluindo a Central de Cobrança operacional. Versões anteriores já registradas são preservadas. O código da função de importação permanece o mesmo da 0.9.0; seguir o [guia atual de Cobrança](central-cobranca-operacao.md). Os passos abaixo preservam a ativação dos recebíveis e continuam úteis quando a função ainda não foi publicada.

Esta atualização preserva o endereço, usuários, permissões, títulos, responsáveis, contatos, recebimentos, saldos, arquivos e históricos existentes. O envio de código pelo Git não executa SQL ou publica funções no Supabase.

## Atualizar o projeto existente

1. Abra o [SQL combinado atualizado](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/ativar-recebiveis-operacao.sql), clique em **Raw** e copie tudo.
2. No [SQL Editor do projeto](https://supabase.com/dashboard/project/sjimddcqgrsauzvffcol/sql/new), cole em uma consulta nova e execute **Run**. O arquivo aplica somente versões faltantes numa transação. Exige o módulo CR/Cobrança 009 já instalado; não depende de CP 021. Não repetir os scripts antigos 008/009/010/011 nem remover tabelas. Se houver erro, preserve a mensagem completa para análise.
3. Em **Edge Functions**, abra **receivables-import → Code → index.ts**. Substitua todo o conteúdo pelo [código atualizado da função](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/dashboard/receivables-import.ts) e publique. Se `receivables-import` ainda não existir, crie via editor com esse nome exato; não use um nome automático. Preserve `auth-gateway`, `payables-import` e `ALLOWED_ORIGINS`. Mantenha **Verify JWT with legacy secret** desativado: o código verifica token, sessão e permissões oficiais.
4. Aguarde o deploy da branch `main` na Cloudflare, atualize a Central e confira **Versão 0.10.0**.

O arquivo **.sql vai no SQL Editor**. O arquivo **.ts vai no editor da função**, nunca no SQL Editor. O combinado pode ser repetido: versões já registradas são ignoradas. Não executar também as quatro migrations individuais após o combinado. Não é necessário novo serviço pago ou nova credencial.

## Usar os relatórios

Em **Importar Bases → Contas a Receber**, escolha **Abertos e vencidos** ou **Títulos quitados**, selecione o arquivo correspondente, analise a cópia e confirme os dados. A Central reconhece os cabeçalhos dos modelos enviados. Arquivo de quitados não pode ser usado como relatório de abertos.

Na primeira base, confira as responsáveis em Contas a Receber. Atribuições existentes são preservadas e novos títulos herdam a única cobradora conhecida da dívida ativa do cliente. Sem vínculo, a Central não escolhe uma pessoa. Para uma parcela ambígua, selecione a parcela correta ou confirme uma nova parcela e reanalise. Títulos quitados históricos podem ser incluídos sem inventar previsão em aberto.

Ao concluir os quitados, os títulos ficam validados, deixam a carteira ativa e alimentam os recebimentos e a base de comissões. Repetir o arquivo não duplica valores. Diferenças entre valor original e recebido são preservadas; a base da comissão é o recebido. A confirmação de correção mantém as versões anteriores. Conflito com recebimento manual exige conferência.

Atualize **Cobrança** para consultar os vencidos por carteira, faixa, contato e retorno. No **Painel**, confira atraso, total a receber e recebido diário. Em **Comissões**, filtre o período real de recebimento e a responsável; a tela apresenta a base e as pendências. As taxas e vigências ainda precisam ser definidas para calcular comissões.

Conferir com os relatórios operacionais reais antes de usar os números para decisão. Os arquivos fornecidos foram lidos e ensaiados em banco local isolado; nenhuma importação de produção foi executada pelo agente. Descrição completa das regras: [contas-receber-fluxo.md](contas-receber-fluxo.md).
