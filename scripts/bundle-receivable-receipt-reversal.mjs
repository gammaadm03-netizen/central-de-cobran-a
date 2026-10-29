import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildReceivableReceiptReversalSql() {
 const sources=await Promise.all(['053_receivable_financial_validation.sql','055_receivable_validation_commissions.sql','056_receivable_receipt_reversal.sql'].map(name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8')));
 return `-- CENTRAL FINANCEIRA — estorno auditado de validação financeira (056).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o SQL 047. Inclui os SQLs 053 e 055 quando ainda não ativados.
-- Preserva os recebimentos originais e não estorna nenhum título automaticamente.
-- Somente a Gerência Geral pode confirmar um estorno na Central, com justificativa.
-- Não é necessária atualização de Edge Function.
\n${sources.join('\n')}`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../supabase/dashboard/ativar-estorno-validacao-recebiveis.sql',import.meta.url),await buildReceivableReceiptReversalSql());
 console.log('Generated receivable receipt reversal SQL. No remote SQL executed.');
}
