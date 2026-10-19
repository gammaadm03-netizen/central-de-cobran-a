import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildUserAccessLimitsSql() {
  return readFile(new URL('../supabase/migrations/039_user_access_limits.sql', import.meta.url), 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-limites-usuarios.sql', import.meta.url), await buildUserAccessLimitsSql());
  console.log('Generated individual access limit activation. No remote SQL executed.');
}
