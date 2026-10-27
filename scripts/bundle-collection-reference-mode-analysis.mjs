import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildCollectionReferenceModeAnalysisSql() {
  const source = await readFile(new URL('../supabase/migrations/049_collection_reference_preview_work.sql', import.meta.url), 'utf8');
  return `-- CENTRAL FINANCEIRA — estatísticas e processamento da conferência de contatos (049).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o SQL 048. Não precisa republicar a Edge Function já atualizada.
-- Preserva os arquivos preparados e os dados existentes; não conclui importações.
-- Orientações: docs/conferencia-contatos-descricoes.md.
\n${source}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-conferencia-contatos-por-tipo.sql', import.meta.url), await buildCollectionReferenceModeAnalysisSql());
  console.log('Generated collection reference mode analysis SQL. No remote SQL or imports executed.');
}
