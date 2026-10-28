import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildCollectionContactRefreshSql() {
 const names = ['048_collection_reference_analysis.sql', '049_collection_reference_preview_work.sql', '052_collection_contact_refresh.sql'];
 const sources = await Promise.all(names.map(name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')));
 return `-- CENTRAL FINANCEIRA — atualização de contatos dos órgãos (052).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Instala 048, 049 e 052; requer a estrutura de referências e o SQL 047 já ativados.
-- Pode executar novamente. Preserva arquivos preparados, fichas manuais e dados financeiros.
-- Esta atualização não importa nem publica planilhas automaticamente.
\nDO $contact_refresh_prerequisite$ BEGIN
 IF to_regclass('public.central_schema_migrations') IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.central_schema_migrations WHERE version='047_receivables_complete_report') THEN
  RAISE EXCEPTION 'Ative o SQL 047 de Contas a Receber antes desta atualização.' USING ERRCODE='22023';END IF;
END $contact_refresh_prerequisite$;
\n${sources.join('\n\n')}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 await writeFile(new URL('../supabase/dashboard/ativar-atualizacao-contatos-orgaos.sql', import.meta.url), await buildCollectionContactRefreshSql());
 console.log('Generated contact refresh installer. No remote SQL or imports executed.');
}
