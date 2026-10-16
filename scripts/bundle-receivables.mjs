import { readFile, writeFile } from 'node:fs/promises';

const sources = ['008_receivables.sql', '009_collections.sql', '010_bank_import.sql', '011_receivables_positions.sql'];
const parts = [];
for (const source of sources) {
  const sql = await readFile(new URL(`../supabase/migrations/${source}`, import.meta.url), 'utf8');
  if ((sql.match(/^BEGIN;\s*$/gmi) ?? []).length !== 1 || (sql.match(/^COMMIT;\s*$/gmi) ?? []).length !== 1) throw new Error('Expected one transaction per migration');
  parts.push(`-- SOURCE: ${source}\n${sql.replace(/^BEGIN;\s*$/gmi, '').replace(/^COMMIT;\s*$/gmi, '').trim()}`);
}
await writeFile(new URL('../supabase/dashboard/ativar-recebiveis.sql', import.meta.url), `-- Central Financeira 0.4.0. Apply ONCE after 001/003/004/005/006/007.\n-- Preserves existing payables, users, balances, messages and historical positions.\nBEGIN;\n\n${parts.join('\n\n')}\n\nCOMMIT;\n`);
console.log('Generated atomic CR/collection/bank activation SQL; no remote execution performed.');
