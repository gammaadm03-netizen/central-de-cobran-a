import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildReceivableImportCompletionSql() {
  const names = ['053_receivable_financial_validation.sql', '055_receivable_validation_commissions.sql', '056_receivable_receipt_reversal.sql', '057_receivable_return_approval.sql', '062_receivable_import_completion.sql'];
  const sources = await Promise.all(names.map(async name => {
    const source = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
    if ((source.match(/^BEGIN;\s*$/gm) ?? []).length !== 1 || (source.match(/^COMMIT;\s*$/gm) ?? []).length !== 1) throw new Error(`Invalid outer transaction: ${name}`);
    return `-- SOURCE: ${name}\n${source.replace(/^BEGIN;[\t ]*\r?\n/m, '').replace(/^COMMIT;[\t ]*\r?\n?$/m, '').trim()}`;
  }));
  return `-- CENTRAL FINANCEIRA — confirmação e processamento da importação de recebíveis (062).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o relatório completo047. Inclui053/055/056/057 quando necessárias.
-- Instalação atômica: preserva bases, arquivos, carteiras, recebimentos e históricos.
-- Não importa planilhas nem confirma, estorna ou retira títulos durante a instalação.
-- Depois publique a função receivables-import.ts atualizada.
-- Se houver envio pendente, mantenha a tela aberta até conferir o mesmo protocolo.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(2045812301);
${sources.join('\n\n')}
COMMIT;
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-confirmacao-importacao-recebiveis.sql', import.meta.url), await buildReceivableImportCompletionSql());
  console.log('Generated complete receivables import completion SQL; no remote execution.');
}
