import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECEIVABLES_OPERATION_MIGRATIONS = [
  '022_collections_overdue_only.sql',
  '023_receivable_sync.sql',
  '024_receivable_received_import.sql',
  '025_collections_management.sql',
  '026_collection_workbench.sql',
  '027_collection_customer_context.sql',
  '028_collection_reference_imports.sql',
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

export async function buildReceivablesOperationsSql() {
  const parts = [];
  for (const source of RECEIVABLES_OPERATION_MIGRATIONS) {
    const original = await readFile(new URL(`../supabase/migrations/${source}`, import.meta.url), 'utf8');
    const version = source.replace(/\.sql$/, '');
    if (!original.includes(`'${version}'`)) throw new Error(`${source}: missing its schema migration registry version.`);
    const body = `-- SOURCE BODY: ${source}\n${stripTransaction(original, source).trim()}\n-- END SOURCE BODY: ${source}`;
    const sourceTag = dollarTag(`cf_cr_source_${version.slice(0, 3)}`, body);
    const statements = `BEGIN\n  IF EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='${version}') THEN\n    RAISE NOTICE 'Atualização ${version} já instalada; dados e configurações preservados.';\n  ELSE\n    EXECUTE ${sourceTag}\n${body}\n${sourceTag};\n    IF NOT EXISTS (SELECT 1 FROM public.central_schema_migrations WHERE version='${version}') THEN\n      RAISE EXCEPTION 'A atualização ${version} não registrou sua versão; nenhuma alteração será mantida.' USING ERRCODE='22023';\n    END IF;\n  END IF;\nEND;`;
    const wrapperTag = dollarTag(`cf_cr_apply_${version.slice(0, 3)}`, statements);
    parts.push(`-- SOURCE: ${source}\nDO ${wrapperTag}\n${statements}\n${wrapperTag};`);
  }
  return `-- CENTRAL FINANCEIRA — ativação da operação de Contas a Receber e Cobrança (022 a 028).
-- Copie o arquivo inteiro no SQL Editor. Uma transação: falha desfaz toda a ativação.
-- Pode ser executado novamente: pula versões já registradas, sem refazer dados.
-- Preserva usuários, títulos, responsáveis, recebimentos, saldos, arquivos e históricos.
-- Exige a base de Contas a Receber e Cobrança até 009; não depende de CP 010 a 021.
-- Não executa importação de planilhas nem deploy de funções.
-- 027/028 acrescentam contatos e descrições somente no atendimento da Cobrança.
BEGIN;

DO $cf_receivables_activation_base$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('central-financeira:receivables-activation',0));
  IF pg_catalog.to_regclass('public.central_schema_migrations') IS NULL
    OR pg_catalog.to_regclass('public.profiles') IS NULL
    OR pg_catalog.to_regclass('public.audit_events') IS NULL
    OR pg_catalog.to_regclass('cf_private.approved_sessions') IS NULL
    OR pg_catalog.to_regclass('public.receivable_imports') IS NULL
    OR pg_catalog.to_regclass('public.receivable_titles') IS NULL
    OR pg_catalog.to_regclass('public.receivable_receipts') IS NULL
    OR pg_catalog.to_regclass('public.receivable_collection_events') IS NULL
    OR pg_catalog.to_regclass('public.collection_agents') IS NULL
    OR pg_catalog.to_regclass('public.collector_bindings') IS NULL
    OR pg_catalog.to_regclass('cf_private.receivable_import_files') IS NULL
    OR pg_catalog.to_regprocedure('cf_private.has_permission(text,text)') IS NULL
    OR pg_catalog.to_regprocedure('cf_private.require_receivable_finance(text)') IS NULL THEN
    RAISE EXCEPTION 'A base de Contas a Receber e Cobrança está incompleta. Ative a base até a atualização 009 antes desta operação; nenhum dado foi alterado.' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='009_collections') THEN
    RAISE EXCEPTION 'A atualização 009_collections não está registrada. Confira a base de Cobrança antes desta operação; nenhum dado foi alterado.' USING ERRCODE='22023';
  END IF;
END;
$cf_receivables_activation_base$;

${parts.join('\n\n')}

COMMIT;
`;
}

export async function writeReceivablesOperationsBundle() {
  const sql = await buildReceivablesOperationsSql();
  await writeFile(new URL('../supabase/dashboard/ativar-recebiveis-operacao.sql', import.meta.url), sql);
  return sql;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeReceivablesOperationsBundle();
  console.log('Generated one atomic, repeatable CR and Collections activation SQL; no remote execution performed.');
}
