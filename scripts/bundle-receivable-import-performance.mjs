import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildReceivableImportPerformanceSql() {
  const source = await readFile(new URL('../supabase/migrations/041_receivable_import_performance.sql', import.meta.url), 'utf8');
  return `-- CENTRAL FINANCEIRA — otimização da importação de Contas a Receber.
-- Cole este SQL completo no SQL Editor; não é código de Edge Function.
-- Executar após as atualizações 023 e 024. Não exige a atualização de e-mail 040.
-- Repetível: não importa planilhas, não altera dados nem refaz vínculos.
-- Mantém a comparação exata de identidade e utiliza o índice existente da 023.
-- O deploy do site e da função receivables-import é uma etapa separada.
\n${source}`;
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
