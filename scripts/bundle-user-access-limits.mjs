import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildUserAccessLimitsSql() {
  const source = await readFile(new URL('../supabase/migrations/039_user_access_limits.sql', import.meta.url), 'utf8');
  const body = source.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '').trim();
  if (body.includes('$cf_limits_source$')) throw new Error('Conflicting SQL delimiter.');
  return `-- Limites individuais. Executar inteiro no SQL Editor.
-- Preserva concessões individuais de importação instaladas pela atualização046.
BEGIN;
SELECT pg_advisory_xact_lock(2045812301);
DO $cf_limits_activation$
BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative primeiro a base financeira da Central.' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='046_user_import_access') THEN
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='039_user_access_limits') THEN
   RAISE EXCEPTION 'Registro de versões inconsistente. Confira039 e046.' USING ERRCODE='22023';
  END IF;
  RAISE NOTICE 'Limites039 já instalados; concessões individuais046 preservadas.';
 ELSE
  EXECUTE $cf_limits_source$
${body}
$cf_limits_source$;
 END IF;
END;
$cf_limits_activation$;
NOTIFY pgrst, 'reload schema';
COMMIT;
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-limites-usuarios.sql', import.meta.url), await buildUserAccessLimitsSql());
  console.log('Generated individual access limit activation. No remote SQL executed.');
}
