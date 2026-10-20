import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildUserImportAccessSql() {
  return readFile(new URL('../supabase/migrations/046_user_import_access.sql', import.meta.url), 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-acesso-importacoes-usuario.sql', import.meta.url), await buildUserImportAccessSql());
  console.log('Generated individual import access activation. No real user configured and no remote SQL executed.');
}
