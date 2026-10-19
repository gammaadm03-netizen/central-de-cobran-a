import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildDirectorAccessSql() {
  const sql = await readFile(new URL('../supabase/migrations/031_director_readonly.sql', import.meta.url), 'utf8');
  const body = sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '').trim();
  if (body.includes('$cf_director_source$')) throw new Error('Conflicting SQL delimiter.');
  return `-- Diretoria em consulta. Executar inteiro no SQL Editor.
-- Preserva os limites individuais caso a atualização 039 já esteja instalada.
BEGIN;
SELECT pg_advisory_xact_lock(2045812301);
DO $cf_director_activation$
BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative primeiro a base financeira da Central.' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='039_user_access_limits') THEN
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='031_director_readonly') THEN
   RAISE EXCEPTION 'Registro de versões inconsistente. Confira as atualizações 031 e 039.' USING ERRCODE='22023';
  END IF;
  RAISE NOTICE 'Diretoria já atualizada; limites individuais da 039 preservados.';
 ELSE
  EXECUTE $cf_director_source$
${body}
$cf_director_source$;
 END IF;
END;
$cf_director_activation$;
NOTIFY pgrst, 'reload schema';
COMMIT;
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-acesso-diretoria.sql', import.meta.url), await buildDirectorAccessSql());
  console.log('Generated Director activation preserving individual access limits. No remote SQL executed.');
}
