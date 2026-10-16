# Resumo da Diretoria — atualização 0.6.0

Preserva usuários, saldos, CP, CR, estoque, auditoria e posições históricas. Exige somente a migration incremental 013, após a atualização 012 das 17 contas. Não cria Edge Function, integração com o portal privado ou recurso pago.

## Conferir a atualização anterior

No [SQL Editor do projeto atual](https://supabase.com/dashboard/project/sjimddcqgrsauzvffcol/sql/new), esta consulta é somente leitura:

```sql
SELECT version FROM public.central_schema_migrations
WHERE version IN ('012_treasury_accounts','013_director_report') ORDER BY version;
SELECT count(*) AS contas_ativas FROM public.bank_accounts WHERE enabled;
```

A 012 deve constar no histórico e devem existir 17 contas ativas nesta configuração. Se a 012 faltar, conclua apenas [a atualização das contas](ativacao-contas-caixas.md). Não repita uma migration já aplicada. O retorno vazio de `pg_advisory_xact_lock` é normal, mas não confirma sozinho que todo o arquivo foi executado.

## Executar somente o script novo

1. Abra [013_director_report.sql no GitHub](https://github.com/gammaadm03-netizen/central-de-cobran-a/blob/main/supabase/migrations/013_director_report.sql) e copie todo o conteúdo.
2. Crie uma consulta nova no SQL Editor, cole o script e clique em Run uma vez. Se a 013 já constar no histórico, não a repita.
3. O script verifica a 012 antes de criar estruturas. Se faltar, interrompe com orientação e sem alterações parciais. Não reinstale o banco ou altere as funções de login/importação.
4. Aguarde o deploy da Cloudflare e confira Versão 0.6.0 no rodapé da Central, no endereço existente. Se necessário, atualize com Ctrl + Shift + R.

O site continua consultando saldos e bases existentes enquanto o novo relatório aguarda ativação. Publicar o código não executa o SQL.

## Informar e conferir os dados

Como Gerência, abra **Importar Bases → Resumo da Diretoria**. Selecione a data e informe os valores reais conferidos de faturamento sem COMLURB, faturamento COMLURB, pedidos, pedidos bloqueados, pendências, atrasado COMLURB, parcelamentos e impostos do mês passado. O faturamento geral é a soma dos dois faturamentos, sem contar COMLURB duas vezes. Esta entrada manual não conclui o módulo completo de Faturamento.

Deixe valores desconhecidos vazios; use `0,00` somente para confirmar zero real. Preencha a observação, confira os valores e confirme o salvamento. Cada alteração gera revisão auditada, preservando a anterior. Cada data possui sua posição, sem repetir os dados de ontem automaticamente.

Caixa, recebíveis, estoque e mercadoria vêm das bases centrais e não são sobrescritos pelo formulário. Mercadoria inclui títulos abertos da macro COMPRA DE MERCADORIA. Impostos são referentes ao mês anterior à posição. M49 foi removida expressamente pelo usuário:

```text
(Caixa + Contas a Receber + Estoque
 − Impostos do mês passado − Faturamento geral × 0,14
 − Pagamento de mercadoria − Parcelamentos) ÷ 1.000.000
```

No Painel, clique em Atualizar agora e abra Memória do cálculo para conferir cada componente. O resultado é exibido em milhões. Sem um componente, ele fica pendente; estoque ausente nunca vira zero. Caixa e recebíveis entram uma única vez, mesmo quando repetidos na apresentação do Excel.

Salvar posição preserva indicadores e fontes no histórico. Ver indicadores consulta os dados salvos sem recálculo. Baixar Excel inclui Resumo da Diretoria, Posição diária, Memória do cálculo e Caixa por empresa e banco. Imprimir / PDF usa o layout de impressão. O Diretor consulta/exporta; não informa complementos nem salva posições. O backend também nega suas tentativas de escrita.

Os testes locais usam dados sintéticos e não comprovam execução remota do SQL, término do deploy ou conferência dos valores reais. Nenhuma credencial deve ser enviada pelo chat.
