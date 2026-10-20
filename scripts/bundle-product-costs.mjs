import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function buildProductCostsSql() {
 const parts=[];
 for(const name of ['044_product_costs.sql','045_product_cost_recalculation.sql']) {
  const sql=await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
  if((sql.match(/^BEGIN;$/gm)||[]).length!==1||(sql.match(/^COMMIT;$/gm)||[]).length!==1)throw Error(`Invalid outer transaction: ${name}`);
  parts.push(`-- SOURCE: ${name}\n${sql.replace(/^BEGIN;\n/m,'').replace(/^COMMIT;\s*$/m,'').trim()}`);
 }
 return `-- CENTRAL FINANCEIRA — Custos oficiais e recálculo explícito versionado de fechamentos.
-- Executar no SQL Editor da base existente após032. Repetível e atômico.
-- Preserva originais, usuários, permissões, fechamentos e apurações salvas.
-- Importar custos não aplica valores a fechamentos: a aplicação exige outra confirmação.
-- Publicar a atualização business-import separadamente; este SQL não publica funções.
BEGIN;\n${parts.join('\n\n')}\nCOMMIT;\n`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){await writeFile(new URL('../supabase/dashboard/ativar-custos-fechamento.sql',import.meta.url),await buildProductCostsSql());console.log('Generated atomic product cost catalogue/recalculation activation. No remote SQL executed.');}
