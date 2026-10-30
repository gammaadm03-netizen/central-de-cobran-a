import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayableUnifiedReportSql } from './bundle-payable-unified-report.mjs';

export async function buildPayableOpenStatusSql() {
 const previous = await buildPayableUnifiedReportSql();
 const source = await readFile(new URL('../supabase/migrations/061_payable_report_status.sql', import.meta.url), 'utf8');
 if ((source.match(/^BEGIN;\s*$/gm) ?? []).length !== 1 || (source.match(/^COMMIT;\s*$/gm) ?? []).length !== 1) throw new Error('Invalid outer transaction: 061');
 return previous.replace('-- CENTRAL FINANCEIRA — relatório completo único de Contas a Pagar (060).', '-- CENTRAL FINANCEIRA — estado Pago pelo relatório diário de Contas a Pagar (061).')
  .replace('-- Requer CP até 021. Inclui 042/043/050/058/059/060. Não limpa bases ou confirma pagamentos durante a instalação.', '-- Requer CP até 021. Inclui 042/043/050/058/059/060/061. Não limpa bases, não estorna pagamentos e não registra pagamentos durante a instalação.')
  .replace(/COMMIT;\s*$/, () => `-- SOURCE: 061_payable_report_status.sql\n${source.replace(/^BEGIN;[\t ]*\r?\n/m, '').replace(/^COMMIT;[\t ]*\r?\n?$/m, '').trim()}\n\nCOMMIT;\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../supabase/dashboard/ativar-status-relatorio-contas-pagar.sql', import.meta.url), await buildPayableOpenStatusSql());
 console.log('Generated 061 payable status-only activation SQL; no remote execution or base reset.');
}
