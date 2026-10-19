import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildPayableAdministrativeWriteoffSql() {
  return readFile(new URL('../supabase/migrations/042_payable_administrative_writeoff.sql', import.meta.url), 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-baixas-administrativas-cp.sql', import.meta.url), await buildPayableAdministrativeWriteoffSql());
  console.log('Generated repeatable administrative writeoff activation. No remote SQL executed.');
}
