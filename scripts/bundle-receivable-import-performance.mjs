import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildReceivableImportPerformanceSql() {
  const source = await readFile(new URL('../supabase/migrations/041_receivable_import_performance.sql', import.meta.url), 'utf8');
  const body = source.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '').trim();
  if (body.includes('$cf_import_performance_source$')) throw new Error('Conflicting SQL delimiter.');
  const activation = `BEGIN;
SELECT pg_advisory_xact_lock(2045812301);
DO $cf_import_performance_guard$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL THEN
  RAISE EXCEPTION 'Ative primeiro a base financeira da Central.' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='047_receivables_complete_report') THEN
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='041_receivable_import_performance') THEN
   RAISE EXCEPTION 'Registro de versões inconsistente. Confira041 e047.' USING ERRCODE='22023';
  END IF;
  RAISE NOTICE 'Otimização041 já instalada; sincronização047 preservada.';
 ELSE
  EXECUTE $cf_import_performance_source$\n${body}\n$cf_import_performance_source$;
 END IF;
END $cf_import_performance_guard$;
NOTIFY pgrst, 'reload schema';
COMMIT;`;
  return `-- CENTRAL FINANCEIRA — otimização da importação de Contas a Receber.
-- Cole este SQL completo no SQL Editor; não é código de Edge Function.
-- Executar após as atualizações 023 e 024. Não exige a atualização de e-mail 040.
-- Repetível: não importa planilhas, não altera dados nem refaz vínculos.
-- Mantém a comparação exata de identidade e utiliza o índice existente da 023.
-- O deploy do site e da função receivables-import é uma etapa separada.
\n${activation}`;
}

export async function writeReceivableImportPerformanceBundle() {
  const source = await buildReceivableImportPerformanceSql();
  await writeFile(new URL('../supabase/dashboard/ativar-otimizacao-importacao-recebiveis.sql', import.meta.url), source);
  return source;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeReceivableImportPerformanceBundle();
  console.log('Generated standalone receivables import optimization SQL; no remote execution performed.');
}
