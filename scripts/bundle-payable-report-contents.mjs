import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayableOpenStatusSql } from './bundle-payable-open-status.mjs';

export async function buildPayableReportContentsSql() {
  const base = await buildPayableOpenStatusSql();
  const names = ['065_payable_report_contents.sql', '066_director_merchandise_plan.sql'];
  const sources = await Promise.all(names.map(async name => {
    const source = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
    if ((source.match(/^BEGIN;\s*$/gm) ?? []).length !== 1 || (source.match(/^COMMIT;\s*$/gm) ?? []).length !== 1) throw new Error(`Invalid outer transaction: ${name}`);
    return `-- SOURCE: ${name}\n${source.replace(/^BEGIN;[\t ]*\r?\n/m, '').replace(/^COMMIT;[\t ]*\r?\n?$/m, '').trim()}`;
  }));
  return `-- CENTRAL FINANCEIRA — relatórios de abertos e de baixados em Contas a Pagar (065/066).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Inclui a rotina061 e diferencia a relação completa de abertos dos títulos baixados.
-- Mercadoria da Diretoria usa o Plano cp COMPRA DE MERCADORIA e o saldo em aberto.
-- A instalação preserva bases, títulos, pagamentos, carteiras e históricos.
-- Não aplica baixas ou reaberturas durante a instalação.
-- Depois publique a função payables-import.ts atualizada.
${base.replace(/^-- CENTRAL FINANCEIRA[^\n]*\n/, '').replace(/COMMIT;\s*$/, `${sources.join('\n\n')}\n\nCOMMIT;\n`)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/ativar-tipos-relatorios-contas-pagar.sql', import.meta.url), await buildPayableReportContentsSql());
  console.log('Generated payable report contents and merchandise activation SQL; no remote execution or base reset.');
}
