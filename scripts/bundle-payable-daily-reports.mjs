import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildPayableDailyReportsSql() {
 const sources=[];
 for(const name of ['042_payable_administrative_writeoff.sql','043_payable_import_reconciliation.sql','050_paid_bank_rules.sql','058_payable_daily_reports.sql']) {
  const sql=await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
  if((sql.match(/^BEGIN;\s*$/gm)??[]).length!==1||(sql.match(/^COMMIT;\s*$/gm)??[]).length!==1)throw new Error(`Invalid outer transaction: ${name}`);
  sources.push(`-- SOURCE: ${name}\n${sql.replace(/^BEGIN;[\t ]*\r?\n/m,'').replace(/^COMMIT;[\t ]*\r?\n?$/m,'').trim()}`);
 }
 return `-- CENTRAL FINANCEIRA — conciliação diária de títulos e cheques (058).
-- Cole TODO o conteúdo em Supabase > SQL Editor > New query > Run.
-- Requer CP até 021. Inclui 042/043/050/058, preservando as correspondências bancárias já configuradas.
-- Não importa arquivos nem confirma baixas durante a instalação.
-- Depois publique o arquivo completo payables-import.ts e atualize a Central.
\nBEGIN;\n\n${sources.join('\n\n')}\n\nCOMMIT;\n`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../supabase/dashboard/ativar-conciliacao-diaria-contas-pagar.sql',import.meta.url),await buildPayableDailyReportsSql());
 console.log('Generated058 daily payable reports SQL; no remote execution.');
}
