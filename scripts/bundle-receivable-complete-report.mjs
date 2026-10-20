import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildReceivableCompleteReportSql() {
  const source = await readFile(new URL('../supabase/migrations/047_receivables_complete_report.sql', import.meta.url), 'utf8');
  return `-- CENTRAL FINANCEIRA — sincronização do relatório completo de Contas a Receber.
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Não cole SQL na Edge Function. Não importa planilhas nem retira títulos durante a instalação.
-- Depois publique o arquivo receivables-import.ts na Edge Function receivables-import.
-- Veja docs/recebiveis-relatorio-completo.md para conferir os pré-requisitos e o fluxo.
\n${source}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-relatorio-completo-recebiveis.sql', import.meta.url), await buildReceivableCompleteReportSql());
  console.log('Generated complete receivables report activation SQL. No remote SQL or imports executed.');
}
