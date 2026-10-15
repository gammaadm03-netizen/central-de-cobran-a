import { readFile, writeFile } from 'node:fs/promises';

const sources = ['005_payables.sql', '006_treasury.sql', '007_director_positions.sql'];
const parts = [];
for (const source of sources) {
  const sql = await readFile(new URL(`../supabase/migrations/${source}`, import.meta.url), 'utf8');
  if ((sql.match(/^BEGIN;\s*$/gmi) ?? []).length !== 1 || (sql.match(/^COMMIT;\s*$/gmi) ?? []).length !== 1) throw new Error('Expected one transaction per migration');
  parts.push(`-- SOURCE: ${source}\n${sql.replace(/^BEGIN;\s*$/gmi, '').replace(/^COMMIT;\s*$/gmi, '').trim()}`);
}
await writeFile(new URL('../supabase/dashboard/ativar-financeiro.sql', import.meta.url), `-- Central Financeira 0.3.0: apply ONCE after 001/003/004.\n-- All three migrations below form ONE transaction. No passwords or financial seed balances.\nBEGIN;\n\n${parts.join('\n\n')}\n\nCOMMIT;\n`);
console.log('Generated combined financial activation SQL; no remote execution performed.');
