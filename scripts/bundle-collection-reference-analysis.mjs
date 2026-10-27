import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildCollectionReferenceAnalysisSql() {
  const source = await readFile(new URL('../supabase/migrations/048_collection_reference_analysis.sql', import.meta.url), 'utf8');
  return `-- CENTRAL FINANCEIRA — conferência de contatos e descrições (048).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Não cole este SQL na Edge Function. Requer as atualizações 028 e 047.
-- Preserva os arquivos já preparados; não importa dados nem apaga bases.
-- Depois atualize a função EXISTENTE collection-reference-import com collection-reference-import.ts.
-- Orientações: docs/conferencia-contatos-descricoes.md.
\n${source}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-conferencia-contatos-descricoes.sql', import.meta.url), await buildCollectionReferenceAnalysisSql());
  console.log('Generated collection reference analysis SQL. No remote SQL or imports executed.');
}
