import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildCollectionTitleTimeSql() {
  const source = await readFile(new URL('../supabase/migrations/067_collection_title_time.sql', import.meta.url), 'utf8');
  return `-- CENTRAL FINANCEIRA — tempo total do título consistente entre perfis (067).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o atendimento da Cobrança029 já instalado.
-- O total reúne o tempo registrado por todos no título autorizado.
-- O tempo pessoal, a sessão em andamento e os acessos de carteira são preservados.
-- Preserva intervalos, recebimentos, comissões, agendas e históricos existentes.
-- Esta atualização não exige publicação de Edge Function.
\n${source}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-tempo-total-titulo-cobranca.sql', import.meta.url), await buildCollectionTitleTimeSql());
  console.log('Generated collection title time activation SQL; no remote execution.');
}
