import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildPayableImportReconciliationSql() {
  const names = ['042_payable_administrative_writeoff.sql', '043_payable_import_reconciliation.sql'];
  const parts = [];
  for (const name of names) {
    const source = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
    if ((source.match(/^BEGIN;\s*$/gm) ?? []).length !== 1 || (source.match(/^COMMIT;\s*$/gm) ?? []).length !== 1) throw new Error(`${name}: expected one outer transaction`);
    parts.push(`-- SOURCE: ${name}\n${source.replace(/^BEGIN;[\t ]*\r?\n/m, '').replace(/^COMMIT;[\t ]*\r?\n?$/m, '').trim()}`);
  }
  return `-- CENTRAL FINANCEIRA — baixas sem pagamento e conciliação na importação (042/043).
-- Cole o SQL completo no SQL Editor. Uma falha desfaz toda a ativação.
-- Repetível e independente de recebíveis/e-mail 040/041. Requer CP até 021.
-- Não importa arquivos, não presume pagamentos e não altera títulos existentes.
-- Depois publique a função payables-import e confira a versão correspondente do site.
BEGIN;\n\n${parts.join('\n\n')}\n\nCOMMIT;\n`;
}
export async function writePayableImportReconciliationSql() {
  const sql = await buildPayableImportReconciliationSql();
  await writeFile(new URL('../supabase/dashboard/ativar-conciliacao-importacao-contas-pagar.sql', import.meta.url), sql);
  return sql;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writePayableImportReconciliationSql();
  console.log('Generated atomic CP import reconciliation activation SQL; no remote execution performed.');
}
