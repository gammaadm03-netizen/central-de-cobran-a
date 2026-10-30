import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayableUnifiedReportSql } from './bundle-payable-unified-report.mjs';

function transactionBody(sql, label) {
  if ((sql.match(/^BEGIN;\s*$/gm) ?? []).length !== 1 || (sql.match(/^COMMIT;\s*$/gm) ?? []).length !== 1) throw new Error(`Invalid transaction: ${label}`);
  return sql.replace(/^BEGIN;[\t ]*\r?\n/m, '').replace(/^COMMIT;[\t ]*\r?\n?/m, '').trim();
}

export async function buildPayableUnifiedRestartSql() {
  const activation = await buildPayableUnifiedReportSql();
  const reset = await readFile(new URL('../supabase/admin/zerar-somente-contas-pagar-2026-10-30.sql', import.meta.url), 'utf8');
  const result = 'SELECT * FROM pg_temp._cf_payable_reset_result;';
  if (reset.split(result).length !== 2 || !reset.trimEnd().endsWith(result)) throw new Error('Missing CP-only reset result');
  return `-- CENTRAL FINANCEIRA — ativação 060 E reinício autorizado SOMENTE de Contas a Pagar.
-- SOLICITADO EM 30/10/2026: ESTE SQL ZERA A BASE OPERACIONAL DE CONTAS A PAGAR.
-- Antes de zerar, confere uma cópia privada recuperável das 21 tabelas de CP.
-- Preserva Contas a Receber, Cobrança, Comissões, Caixa/Bancos, estoque e configurações.
-- Execute TODO o conteúdo em Supabase > SQL Editor > New query > Run, como postgres.
-- A operação cp-restart-2026-10-30-v1 só limpa uma vez; repetir não apaga a nova base.
-- Instalação, cópia e limpeza usam UMA transação: uma falha desfaz todas as etapas.
-- Depois atualize a Edge Function payables-import e importe o novo relatório completo.

BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
DO $cp_restart_owner$ BEGIN
 IF current_user NOT IN ('postgres','supabase_admin') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'Execute este SQL pelo SQL Editor como proprietário do banco.' USING ERRCODE='42501';
 END IF;
END $cp_restart_owner$;

-- ETAPA 1: instalar a rotina. Os comentários das migrations descrevem esta etapa isoladamente.
${transactionBody(activation, '060 activation')}

-- ETAPA 2: cópia conferida e limpeza SOMENTE de CP, já autorizada pelo usuário.
${transactionBody(reset.replace(result, ''), 'CP-only reset')}

COMMIT;
${result}
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../supabase/dashboard/reiniciar-contas-pagar-relatorio-unico.sql', import.meta.url), await buildPayableUnifiedRestartSql());
  console.log('Generated authorized CP-only restart and 060 activation; no remote execution.');
}
