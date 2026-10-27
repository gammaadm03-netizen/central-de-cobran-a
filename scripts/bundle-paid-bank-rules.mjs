import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
export async function buildPaidBankRulesSql(aliases = []) {
  if (!Array.isArray(aliases) || aliases.length > 500 || aliases.some(item => !item || typeof item.source !== 'string' || !item.source.trim() || item.source.length > 300
    || typeof item.official_name !== 'string' || !item.official_name.trim() || item.official_name.length > 200 || /[\u0000-\u001f\u007f]/.test(item.source + item.official_name))) throw new Error('Invalid bank rule configuration.');
  const source = await readFile(new URL('../supabase/migrations/050_paid_bank_rules.sql', import.meta.url), 'utf8');
  let seed = '';
  if (aliases.length) {
    seed = `\n-- Configuração privada das correspondências fornecidas pela administração.\nINSERT INTO cf_private.payable_paid_bank_aliases(source_key,official_bank_name) VALUES\n${aliases.map(item => ` (cf_private.payable_paid_bank_text_key(${quote(item.source)}),${quote(item.official_name)})`).join(',\n')}\nON CONFLICT(source_key) DO UPDATE SET official_bank_name=EXCLUDED.official_bank_name;\n`;
  }
  return `-- CENTRAL FINANCEIRA — bancos de pagamentos e baixas individuais (050).
-- Cole TODO este arquivo em Supabase > SQL Editor > New query > Run.
-- Depois atualize a função EXISTENTE payables-import com o arquivo completo payables-import.ts.
-- ${aliases.length ? 'Contém configuração privada: mantenha este arquivo fora do repositório público.' : 'Estrutura sem correspondências privadas. Use o instalador configurado entregue à administração.'}
-- Não importa planilhas, cria contas, informa saldos ou confirma baixas durante a instalação.
\n${source.replace(/COMMIT;\s*$/, seed + '\nCOMMIT;\n')}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), configIndex = args.indexOf('--config'), outputIndex = args.indexOf('--output');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : null;
  const output = resolve(outputIndex >= 0 ? args[outputIndex + 1] : root + '/supabase/dashboard/ativar-bancos-baixas-contas-pagar.sql');
  if (configPath && (output === root || output.startsWith(root + sep))) throw new Error('Write configured bank rules outside the public repository.');
  const aliases = configPath ? JSON.parse(await readFile(configPath, 'utf8')) : [];
  await writeFile(output, await buildPaidBankRulesSql(aliases));
  console.log('Generated bank rules installer. No remote SQL or imports executed.');
}
