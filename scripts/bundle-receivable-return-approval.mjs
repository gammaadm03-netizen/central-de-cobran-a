import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReceivableReceiptReversalSql } from './bundle-receivable-receipt-reversal.mjs';

export async function buildReceivableReturnApprovalSql() {
 const base=await buildReceivableReceiptReversalSql();
 const source=await readFile(new URL('../supabase/migrations/057_receivable_return_approval.sql',import.meta.url),'utf8');
 return `-- CENTRAL FINANCEIRA — aprovação individual de retorno na importação (057).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Requer o SQL 047 e inclui as atualizações 053, 055 e 056, quando necessárias.
-- Aprovar apenas registra a decisão. Retorno e eventual estorno só ocorrem na confirmação do arquivo.
-- Nenhum título real é alterado por esta instalação. Não há atualização de Edge Function.
\n${base}\n${source}`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../supabase/dashboard/ativar-aprovacao-retorno-recebiveis.sql',import.meta.url),await buildReceivableReturnApprovalSql());
 console.log('Generated receivable return approval SQL. No remote SQL executed.');
}
