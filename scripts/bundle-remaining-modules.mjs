import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODULE_MIGRATIONS = [
  '031_director_readonly.sql',
  '032_commercial.sql',
  '033_hr.sql',
  '034_commissions.sql',
];

function tag(prefix, body) {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  let serial = 0, result;
  do { result = `$${prefix}_${hash}_${serial++}$`; } while (body.includes(result));
  return result;
}

export async function buildRemainingModulesSql() {
  const parts = [];
  for (const source of MODULE_MIGRATIONS) {
    const sql = await readFile(new URL(`../supabase/migrations/${source}`, import.meta.url), 'utf8');
    const begins = [...sql.matchAll(/^BEGIN;[\t ]*\r?$/gm)];
    const commits = [...sql.matchAll(/^COMMIT;[\t ]*\r?$/gm)];
    const version = source.replace(/\.sql$/, '');
    if (begins.length !== 1 || commits.length !== 1 || begins[0].index >= commits[0].index
      || sql.slice(commits[0].index + commits[0][0].length).trim() || !sql.includes(`'${version}'`)) {
      throw new Error(`${source}: expected one complete registered migration transaction.`);
    }
    const body = (sql.slice(0, begins[0].index) + sql.slice(begins[0].index + begins[0][0].length, commits[0].index)).trim();
    const bodyTag = tag('cf_module_source', body);
    const block = `BEGIN
  IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='${version}') THEN
    RAISE NOTICE 'Atualização ${version} já instalada; histórico preservado.';
  ELSE
    EXECUTE ${bodyTag}
${body}
${bodyTag};
    IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='${version}') THEN
      RAISE EXCEPTION 'A atualização ${version} não registrou sua versão.' USING ERRCODE='22023';
    END IF;
  END IF;
END;`;
    const blockTag = tag('cf_module_apply', block);
    parts.push(`-- SOURCE: ${source}\nDO ${blockTag}\n${block}\n${blockTag};`);
  }
  return `-- CENTRAL FINANCEIRA — Comissões, Faturamento, Margens e RH / DP.
-- Arquivo SQL: executar inteiro no SQL Editor do projeto existente.
-- Uma transação, repetível por versão; não apaga nem importa bases históricas.
-- Inclui a restrição de consulta da Diretoria (031), caso ainda não instalada.
-- A função business-import é publicada separadamente; não colar TypeScript aqui.
BEGIN;
DO $cf_module_base$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('central-financeira:remaining-modules',0));
  IF pg_catalog.to_regclass('public.central_schema_migrations') IS NULL
    OR pg_catalog.to_regclass('cf_private.approved_sessions') IS NULL
    OR pg_catalog.to_regclass('public.receivable_receipts') IS NULL THEN
    RAISE EXCEPTION 'Ative primeiro a base da Central e de Contas a Receber. Nenhuma alteração aplicada.' USING ERRCODE='22023';
  END IF;
END;
$cf_module_base$;

${parts.join('\n\n')}

COMMIT;
`;
}

export async function writeRemainingModulesBundle() {
  const sql = await buildRemainingModulesSql();
  await writeFile(new URL('../supabase/dashboard/ativar-demais-abas.sql', import.meta.url), sql);
  return sql;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeRemainingModulesBundle();
  console.log('Generated repeatable module activation SQL; no remote execution performed.');
}
