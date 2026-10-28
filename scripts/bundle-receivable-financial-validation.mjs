import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildReceivableFinancialValidationSql() {
 const source=await readFile(new URL('../supabase/migrations/053_receivable_financial_validation.sql',import.meta.url),'utf8');
 return `-- CENTRAL FINANCEIRA — validação financeira de Contas a Receber (053).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o SQL 047. Pode ser executado novamente com segurança.
-- Preserva os dados existentes. Não confirma recebimentos automaticamente.
-- Não há atualização de Edge Function nesta mudança.
\n${source}`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../supabase/dashboard/ativar-validacao-financeira-recebiveis.sql',import.meta.url),await buildReceivableFinancialValidationSql());
 console.log('Generated receivable financial validation SQL. No remote SQL executed.');
}
