import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayableDailyReportsSql } from './bundle-payable-daily-reports.mjs';

export async function buildPayableColumnRulesSql() {
 const previous = await buildPayableDailyReportsSql();
 const source = await readFile(new URL('../supabase/migrations/059_payable_column_rules.sql', import.meta.url), 'utf8');
 if ((source.match(/^BEGIN;\s*$/gm) ?? []).length !== 1 || (source.match(/^COMMIT;\s*$/gm) ?? []).length !== 1) throw new Error('Invalid outer transaction: 059');
 return previous.replace('-- CENTRAL FINANCEIRA — conciliação diária de títulos e cheques (058).', '-- CENTRAL FINANCEIRA — colunas de Contas a Pagar e cheques BRADESCO F2G (059).')
  .replace('-- Requer CP até 021. Inclui 042/043/050/058, preservando as correspondências bancárias já configuradas.', '-- Requer CP até 021. Inclui 042/043/050/058/059, preservando os vínculos e históricos existentes.')
  .replace(/COMMIT;\s*$/, () => `-- SOURCE: 059_payable_column_rules.sql\n${source.replace(/^BEGIN;[\t ]*\r?\n/m, '').replace(/^COMMIT;[\t ]*\r?\n?$/m, '').trim()}\n\nCOMMIT;\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../supabase/dashboard/ativar-colunas-contas-pagar.sql', import.meta.url), await buildPayableColumnRulesSql());
 console.log('Generated 059 payable column rules SQL; no remote execution.');
}
