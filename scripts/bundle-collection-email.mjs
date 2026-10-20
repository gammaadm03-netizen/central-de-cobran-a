import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildCollectionEmailSql() {
  const source = '040_collection_email_draft.sql';
  const sql = await readFile(new URL(`../supabase/migrations/${source}`, import.meta.url), 'utf8');
  const begin = [...sql.matchAll(/^BEGIN;[\t ]*\r?$/gm)];
  const commit = [...sql.matchAll(/^COMMIT;[\t ]*\r?$/gm)];
  if (begin.length !== 1 || commit.length !== 1 || begin[0].index >= commit[0].index || sql.slice(commit[0].index + commit[0][0].length).trim()) {
    throw new Error(`${source}: expected exactly one outer BEGIN/COMMIT transaction.`);
  }
  if (!sql.includes("'040_collection_email_draft'")) throw new Error(`${source}: missing its schema migration registry version.`);
  const completeReport = await readFile(new URL('../supabase/migrations/047_receivables_complete_report.sql', import.meta.url), 'utf8');
  const definition = completeReport.match(/CREATE OR REPLACE FUNCTION public\.prepare_collection_customer_email\([\s\S]*?END \$\$;/)?.[0];
  if (!definition || definition.includes('$cf_email_report_source$')) throw new Error('Missing safe complete-report email definition.');
  const preserve = `DO $cf_email_report_guard$ BEGIN
 IF EXISTS(SELECT 1 FROM public.central_schema_migrations WHERE version='047_receivables_complete_report') THEN
  EXECUTE $cf_email_report_source$\n${definition}\n$cf_email_report_source$;
 END IF;
END $cf_email_report_guard$;`;
  return `-- CENTRAL FINANCEIRA — rascunho de e-mail de Cobrança (040).
-- Copie o arquivo inteiro no SQL Editor do projeto existente.
-- Requer a base de Cobrança com 024, contatos 027 e atendimento 029.
-- Não depende dos limites individuais 039; não modifica contas nem permissões de perfis.
-- Repetível; não altera títulos, recebimentos, contatos, atendimentos ou tempos registrados.
-- Não envia e-mails, não marca mensagens como enviadas e não publica Edge Functions.
-- Preserva a exclusão de títulos retirados pela047, inclusive ao ativar e-mail depois dela.
-- SOURCE: ${source}
${sql.slice(0, commit[0].index)}${preserve}
NOTIFY pgrst, 'reload schema';
COMMIT;
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-rascunho-email-cobranca.sql', import.meta.url), await buildCollectionEmailSql());
  console.log('Generated atomic collection email draft activation. No remote SQL executed.');
}
