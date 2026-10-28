import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildCollectionOperationalStatusesSql() {
 const source=await readFile(new URL('../supabase/migrations/054_collection_operational_statuses.sql',import.meta.url),'utf8');
 return `-- CENTRAL FINANCEIRA — novos status do atendimento de Cobrança (054).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o SQL 047. Pode ser executado novamente com segurança.
-- Preserva os dados, a carteira, o histórico e as regras de recebimento.
-- Não há atualização de Edge Function nesta mudança.
\n${source}`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../supabase/dashboard/ativar-status-atendimento-cobranca.sql',import.meta.url),await buildCollectionOperationalStatusesSql());
 console.log('Generated collection status SQL. No remote SQL executed.');
}
