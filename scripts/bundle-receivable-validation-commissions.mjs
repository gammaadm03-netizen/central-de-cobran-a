import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildReceivableValidationCommissionsSql() {
 const sources=await Promise.all(['053_receivable_financial_validation.sql','055_receivable_validation_commissions.sql'].map(name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8')));
 return `-- CENTRAL FINANCEIRA — validação financeira e base de comissões (055).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o SQL 047. Inclui o SQL 053 caso ainda não esteja ativado.
-- Pode ser executado novamente. Preserva os dados e os recebimentos já gravados.
-- Títulos só são confirmados por decisão explícita com data e valor efetivos.
-- Não há atualização de Edge Function nesta mudança.
\n${sources.join('\n')}`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../supabase/dashboard/ativar-validacao-comissoes-recebiveis.sql',import.meta.url),await buildReceivableValidationCommissionsSql());
 console.log('Generated receivable validation and commission SQL. No remote SQL executed.');
}
