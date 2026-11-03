import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildCollectionReturnPriorityRequiredSql() {
  const source = await readFile(new URL('../supabase/migrations/064_collection_return_priority_required.sql', import.meta.url), 'utf8');
  return `-- CENTRAL FINANCEIRA — atender retornos devidos antes de novos atendimentos (064).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer a Cobrança029 e o relatório completo047. Funciona com ou sem a atualização063.
-- Retornos com data até hoje devem ser atendidos antes de iniciar outros títulos.
-- Agendamentos futuros não bloqueiam. Mantém uma sessão ativa por pessoa.
-- Preserva carteiras, recebimentos, intervalos, agendas e históricos existentes.
-- Esta atualização não exige publicação de Edge Function.
\n${source}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-retornos-prioritarios-cobranca.sql', import.meta.url), await buildCollectionReturnPriorityRequiredSql());
  console.log('Generated required collection return priority activation SQL; no remote execution.');
}
