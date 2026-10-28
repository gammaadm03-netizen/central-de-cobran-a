import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildReceivablesDelinquencySql() {
 const source=await readFile(new URL('../supabase/migrations/051_receivables_daily_delinquency.sql',import.meta.url),'utf8');
 return `-- CENTRAL FINANCEIRA — variação diária da inadimplência (051).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Reaplica com segurança. Requer a atualização 047 já ativada.
-- Somente consulta: não importa planilhas, altera títulos ou confirma recebimentos.
-- O histórico usa os registros da base atual e respeita a data oficial de São Paulo.
\n${source}`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../supabase/dashboard/ativar-variacao-diaria-inadimplencia.sql',import.meta.url),await buildReceivablesDelinquencySql());
 console.log('Generated daily delinquency installer. No remote SQL executed.');
}
