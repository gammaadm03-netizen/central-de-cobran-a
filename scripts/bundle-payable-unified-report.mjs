import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayableColumnRulesSql } from './bundle-payable-column-rules.mjs';

export async function buildPayableUnifiedReportSql() {
 const previous = await buildPayableColumnRulesSql();
 const source = await readFile(new URL('../supabase/migrations/060_payable_unified_report.sql', import.meta.url), 'utf8');
 if ((source.match(/^BEGIN;\s*$/gm) ?? []).length !== 1 || (source.match(/^COMMIT;\s*$/gm) ?? []).length !== 1) throw new Error('Invalid outer transaction: 060');
 return previous.replace('-- CENTRAL FINANCEIRA — colunas de Contas a Pagar e cheques BRADESCO F2G (059).', '-- CENTRAL FINANCEIRA — relatório completo único de Contas a Pagar (060).')
  .replace('-- Requer CP até 021. Inclui 042/043/050/058/059, preservando os vínculos e históricos existentes.', '-- Requer CP até 021. Inclui 042/043/050/058/059/060. Não limpa bases ou confirma pagamentos durante a instalação.')
  .replace(/COMMIT;\s*$/, () => `-- SOURCE: 060_payable_unified_report.sql\n${source.replace(/^BEGIN;[\t ]*\r?\n/m, '').replace(/^COMMIT;[\t ]*\r?\n?$/m, '').trim()}\n\nCOMMIT;\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../supabase/dashboard/ativar-relatorio-unico-contas-pagar.sql', import.meta.url), await buildPayableUnifiedReportSql());
 console.log('Generated 060 unified payable report SQL; no remote execution or base reset.');
}
