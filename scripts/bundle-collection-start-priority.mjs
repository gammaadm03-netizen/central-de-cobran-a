import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildCollectionStartPrioritySql() {
  const source = await readFile(new URL('../supabase/migrations/063_collection_start_priority.sql', import.meta.url), 'utf8');
  return `-- CENTRAL FINANCEIRA — iniciar atendimentos com retornos prioritários (063).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer a Cobrança029 e o relatório completo047.
-- Mantém a agenda e permite iniciar outros títulos autorizados da própria carteira.
-- Preserva os intervalos, históricos, recebimentos, permissões e aprovações existentes.
-- Esta atualização não exige publicação de Edge Function.
\n${source}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-inicio-atendimento-cobranca.sql', import.meta.url), await buildCollectionStartPrioritySql());
  console.log('Generated collection start priority activation SQL; no remote execution.');
}
