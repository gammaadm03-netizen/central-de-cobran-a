import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAYABLES_OPERATION_MIGRATIONS = [
  '012_treasury_accounts.sql',
  '013_director_report.sql',
  '014_payables_forecast.sql',
  '015_payable_payments.sql',
  '016_payable_identity_updates.sql',
  '017_payable_month_closing.sql',
  '018_payable_full_payment.sql',
];

function stripTransaction(sql, source) {
  const begin = [...sql.matchAll(/^BEGIN;[\t ]*\r?$/gm)];
  const commit = [...sql.matchAll(/^COMMIT;[\t ]*\r?$/gm)];
  if (begin.length !== 1 || commit.length !== 1 || begin[0].index >= commit[0].index || sql.slice(commit[0].index + commit[0][0].length).trim()) {
    throw new Error(`${source}: expected exactly one outer BEGIN/COMMIT transaction.`);
  }
  return sql.slice(0, begin[0].index) + sql.slice(begin[0].index + begin[0][0].length, commit[0].index);
}

function dollarTag(prefix, body) {
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
  let serial = 0, tag;
  do { tag = `$${prefix}_${digest}_${serial++}$`; } while (body.includes(tag));
  return tag;
}

export async function buildPayablesOperationsSql() {
  const parts = [];
  for (const source of PAYABLES_OPERATION_MIGRATIONS) {
    const original = await readFile(new URL(`../supabase/migrations/${source}`, import.meta.url), 'utf8');
    const version = source.replace(/\.sql$/, '');
    if (!original.includes(`'${version}'`)) throw new Error(`${source}: missing its schema migration registry version.`);
    const body = `-- SOURCE BODY: ${source}\n${stripTransaction(original, source).trim()}\n-- END SOURCE BODY: ${source}`;
    const sourceTag = dollarTag(`cf_source_${version.slice(0, 3)}`, body);
    const statements = `BEGIN\n  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='${version}') THEN\n    RAISE NOTICE 'Atualização ${version} já instalada; dados e configurações preservados.';\n  ELSE\n    EXECUTE ${sourceTag}\n${body}\n${sourceTag};\n    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='${version}') THEN\n      RAISE EXCEPTION 'A atualização ${version} não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';\n    END IF;\n  END IF;\nEND;`;
    const wrapperTag = dollarTag(`cf_apply_${version.slice(0, 3)}`, statements);
    parts.push(`-- SOURCE: ${source}\nDO ${wrapperTag}\n${statements}\n${wrapperTag};`);
  }
  return `-- CENTRAL FINANCEIRA — ativação incremental de Contas a Pagar (012 a 018).
-- Copie o arquivo inteiro no SQL Editor. Uma transação: falha desfaz toda a ativação.
-- Pode ser executado novamente: pula versões já registradas, sem refazer seeds.
-- Preserva usuários, saldos, títulos, pagamentos, arquivos e históricos existentes.
-- Exige a base online anterior (001/003/004 e 005 a 011). Não executa deploy de funções.
BEGIN;

DO $cf_payables_activation_base$
DECLARE v_version text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('central-financeira:payables-activation',0));
  IF pg_catalog.to_regclass('public.central_schema_migrations') IS NULL
    OR pg_catalog.to_regclass('public.profiles') IS NULL
    OR pg_catalog.to_regclass('public.audit_events') IS NULL
    OR pg_catalog.to_regclass('cf_private.approved_sessions') IS NULL
    OR pg_catalog.to_regclass('public.payable_titles') IS NULL
    OR pg_catalog.to_regclass('public.bank_accounts') IS NULL
    OR pg_catalog.to_regclass('public.director_positions') IS NULL
    OR pg_catalog.to_regclass('public.receivable_titles') IS NULL
    OR pg_catalog.to_regprocedure('cf_private.has_permission(text,text)') IS NULL
    OR pg_catalog.to_regprocedure('public.commit_payables_import_from_gateway(uuid,text,text,text,text,text,jsonb,jsonb,boolean,uuid)') IS NULL THEN
    RAISE EXCEPTION 'A base online anterior está incompleta. Ative as atualizações 001/003/004 e 005 a 011 antes de Contas a Pagar; nenhum dado foi alterado.' USING ERRCODE='22023';
  END IF;
  FOREACH v_version IN ARRAY ARRAY['005_payables','006_treasury','007_director_positions',
    '008_receivables','009_collections','010_bank_import','011_receivables_positions'] LOOP
    IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version=v_version) THEN
      RAISE EXCEPTION 'A atualização anterior % não está registrada. Confira a base antes de ativar Contas a Pagar; nenhum dado foi alterado.',v_version USING ERRCODE='22023';
    END IF;
  END LOOP;
END;
$cf_payables_activation_base$;

${parts.join('\n\n')}

COMMIT;
`;
}

export async function writePayablesOperationsBundle() {
  const sql = await buildPayablesOperationsSql();
  await writeFile(new URL('../supabase/dashboard/ativar-contas-pagar.sql', import.meta.url), sql);
  return sql;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writePayablesOperationsBundle();
  console.log('Generated one atomic, repeatable Contas a Pagar activation SQL; no remote execution performed.');
}
