import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import { dailyChequeCsv, dailyCsv, setupDailyImport as setup, selectDailyFile as selectFile } from './helpers/payable-daily-import';

const finish = 'Importar relatório';
const importButton = (page: import('@playwright/test').Page) => page.getByRole('button', { name: finish, exact: true });

test('um clique importa novos títulos e marca ausentes como Pago sem criar pagamentos ou diálogo', async ({ page }) => {
  const seen = await setup(page, { missing: 2 }); page.on('dialog', () => { throw new Error('Importação não deve pedir aprovação adicional'); });
  await selectFile(page); await expect(importButton(page)).toBeEnabled(); expect(seen.commits).toHaveLength(0);
  await expect(page.getByLabel(/Conta diária|Data diária|Banco efetivo/)).toHaveCount(0);
  await importButton(page).click(); await expect(page.getByRole('status')).toContainText('Importação diária concluída.');
  await expect(page.getByRole('status')).toContainText('2 com status Pago');
  expect(seen.commits).toHaveLength(1); expect(seen.payments).toEqual([]); expect(seen.otherWrites).toEqual([]);
  expect(seen.commits[0]).toMatchObject({ status_report_version: '061', mode: 'open_status', report_kind: 'ALL', complete: true, mappings: {}, resolution_choices: {} });
});
test('valores e vencimentos alterados são atualizados sem validar escolhas', async ({ page }) => {
  const seen = await setup(page, { changed: true }); await selectFile(page, dailyCsv.replace('16/10/2026;1.234,56', '04/11/2026;1.555,55'));
  await expect(importButton(page)).toBeEnabled(); await importButton(page).click(); await expect(page.getByRole('status')).toContainText('1 atualizado(s)');
  expect(seen.commits).toHaveLength(1); expect(seen.commits[0].resolution_choices).toEqual({});
  await expect(page.getByRole('button', { name: /Conferir ajustes|Validar escolhas/ })).toHaveCount(0);
});
test('reimportar a posição atual não duplica títulos, baixas ou pagamentos', async ({ page }) => {
  const seen = await setup(page); await selectFile(page); await expect(importButton(page)).toBeEnabled(); await importButton(page).click();
  await expect(page.getByRole('status')).toContainText('1 com status Pago');
  await selectFile(page); await expect(importButton(page)).toBeEnabled(); await importButton(page).click();
  await expect(page.getByRole('status')).toContainText('0 com status Pago'); expect(seen.commits).toHaveLength(2); expect(seen.payments).toEqual([]);
  expect(seen.commits[0].file_base64).toBe(seen.commits[1].file_base64); expect(seen.commits[0].request_id).not.toBe(seen.commits[1].request_id);
});
test('o primeiro relatório estabelece somente a base inicial', async ({ page }) => {
  const seen = await setup(page, { firstReport: true }); await selectFile(page); await expect(importButton(page)).toBeEnabled(); await importButton(page).click();
  await expect(page.getByRole('status')).toContainText('0 com status Pago'); expect(seen.results.values().next().value.baseline_only).toBe(true);
});
test('banco desconhecido, cheque e vencimento futuro não exigem dados financeiros para mudar status', async ({ page }) => {
  const seen = await setup(page, { missing: 3 }); await selectFile(page, dailyChequeCsv.replace('16/10/2026', '04/11/2026').replace('Banco sintético', 'CAIXA INTERNO'), true);
  await expect(importButton(page)).toBeEnabled(); await expect(page.getByRole('combobox')).toHaveCount(0); await importButton(page).click();
  await expect(page.getByRole('status')).toContainText('3 com status Pago'); expect(seen.payments).toEqual([]);
});
test('planos novos seguem sem bloqueio e retornos à previsão são automáticos', async ({ page }) => {
  const seen = await setup(page, { unclassified: true, reopened: true }); await selectFile(page); await expect(importButton(page)).toBeEnabled(); await importButton(page).click();
  await expect(page.getByRole('status')).toContainText('1 retorno(s) à previsão'); expect(seen.commits[0].mappings).toEqual({}); expect(seen.commits[0].resolution_choices).toEqual({});
});
test('cada marcador de um centavo exige confirmação individual e nunca vira pagamento', async ({ page }) => {
  const seen = await setup(page); const csv = dailyCsv.replace('1.234,56', '0,01') + '\r\n15;Outro fornecedor;17/10/2026;0,01;ENERGIA;Banco sintético;3;ABERTO;';
  await selectFile(page, csv); const checks = page.getByRole('checkbox', { name: /Confirmar baixa diária de R\$ 0,01/ }); await expect(checks).toHaveCount(2); await expect(importButton(page)).toBeDisabled();
  await checks.nth(0).check(); await expect(importButton(page)).toBeDisabled(); await checks.nth(1).check(); await importButton(page).click();
  await expect(page.getByRole('status')).toContainText('2 baixa(s) de R$ 0,01'); expect(seen.writeoffs).toEqual(['row:1', 'row:2']); expect(seen.payments).toEqual([]);
});
test('centavo já baixado não exige uma segunda aprovação', async ({ page }) => {
  const seen = await setup(page, { alreadyWrittenOff: true }); await selectFile(page, dailyCsv.replace('1.234,56', '0,01'));
  await expect(importButton(page)).toBeEnabled(); await expect(page.getByRole('checkbox', { name: /Confirmar baixa diária/ })).toHaveCount(0); await importButton(page).click();
  await expect(page.getByRole('status')).toContainText('0 baixa(s) de R$ 0,01'); expect(seen.writeoffs).toEqual([]);
});
test('valores com precisão adicional são arredondados por título e detalhados depois da importação', async ({ page }) => {
  const seen = await setup(page); await selectFile(page, dailyCsv.replace('1.234,56', '3.122,935'));
  await expect(importButton(page)).toBeEnabled(); await expect(page.getByRole('table', { name: 'Valores arredondados por título' })).toHaveCount(0);
  await importButton(page).click(); await expect(page.getByRole('status')).toContainText('Importação diária concluída.'); await page.getByText('1 ajuste(s) de arredondamento para centavos', { exact: true }).click();
  await expect(page.getByRole('table', { name: 'Valores arredondados por título' })).toContainText('R$ 3.122,94');
  expect(seen.commits[0]).not.toHaveProperty('rounding_adjustments'); expect(seen.results.values().next().value.rounding_adjustments).toEqual([{ line: 2, original_amount: '3.122,935', amount_cents: 312294 }]);
});
test('XLSX da origem mantém a cópia original e os zeros do cheque', async ({ page }) => {
  const seen = await setup(page, { firstReport: true }), book = new ExcelJS.Workbook(), sheet = book.addWorksheet('CP');
  sheet.addRow(['Lançamento', 'Histórico', 'Plano cp - Conta: nome', 'Plano cc - Conta: nome', 'Emissão: valor do lançamento', 'Emissão: data', 'Vencimento: data', 'Filial', 'Cheque: número']);
  sheet.addRow(['ERP-14', 'Fornecedor - parcela 2/6', 'ENERGIA', 'Banco previsto sintético', 1234.56, new Date('2026-10-01T15:03:00Z'), new Date('2026-10-16T00:00:00Z'), '3', 719]);
  sheet.getCell('F2').numFmt = 'dd/mm/yyyy hh:mm'; sheet.getCell('G2').numFmt = 'dd/mm/yyyy'; sheet.getCell('I2').numFmt = '000000';
  const bytes = Buffer.from(await book.xlsx.writeBuffer()); await page.getByLabel('Relatório completo diário de Contas a Pagar', { exact: true }).setInputFiles({ name: 'cp.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
  await expect(importButton(page)).toBeEnabled(); await importButton(page).click(); await expect(page.getByRole('status')).toContainText('Importação diária concluída.');
  expect(Buffer.from(seen.commits[0].file_base64, 'base64')).toEqual(bytes); expect(seen.commits[0]).not.toHaveProperty('rows');
});
test('relatório vazio exige declaração explícita e arquivo somente com cabeçalhos', async ({ page }) => {
  const seen = await setup(page); await selectFile(page, dailyCsv.split('\r\n')[0]); await expect(page.getByRole('table', { name: 'Problemas do relatório diário' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Confirmo que o relatório completo não contém títulos em aberto', exact: true }).check(); await expect(importButton(page)).toBeEnabled(); await importButton(page).click();
  await expect(page.getByRole('status')).toContainText('0 título(s) no relatório'); expect(seen.commits[0].empty_report_confirmed).toBe(true);
});
test('resultado incerto preserva exatamente o protocolo e bloqueia outra importação e navegação', async ({ page }) => {
  const seen = await setup(page, { uncertain: true }); await selectFile(page); await expect(importButton(page)).toBeEnabled(); await importButton(page).click();
  const retry = page.getByRole('button', { name: 'Conferir importação diária pendente', exact: true }); await expect(retry).toBeVisible(); const previews = seen.previews.length;
  await expect(page.getByLabel('Relatório completo diário de Contas a Pagar')).toBeDisabled(); await expect(page.getByRole('navigation').getByRole('button', { name: 'Painel Gerencial', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeDisabled();
  await retry.click(); await expect(page.getByRole('status')).toContainText('Este envio já estava concluído'); expect(seen.commits).toHaveLength(2); expect(seen.commits[1]).toEqual(seen.commits[0]); expect(seen.previews).toHaveLength(previews); expect(seen.results.size).toBe(1);
});
test('resposta com pagamento criado indevido fica pendente e mantém o mesmo pedido', async ({ page }) => {
  const seen = await setup(page, { invalidCommit: true }); await selectFile(page); await expect(importButton(page)).toBeEnabled(); await importButton(page).click();
  await expect(page.getByRole('button', { name: 'Conferir importação diária pendente' })).toBeVisible(); await expect(page.getByLabel('Relatório completo diário de Contas a Pagar')).toBeDisabled(); expect(seen.commits).toHaveLength(1);
});
test('concorrência conhecida libera atualização sem apagar arquivo e sem nova confirmação manual', async ({ page }) => {
  const seen = await setup(page, { stale: true }); await selectFile(page); await expect(importButton(page)).toBeEnabled(); await importButton(page).click();
  await expect(page.getByRole('alert')).toContainText('A base ou o dia da importação mudou'); await expect(page.getByLabel('Relatório completo diário de Contas a Pagar')).toHaveValue(/diario.csv$/); await expect(importButton(page)).toBeEnabled(); await expect(page.getByRole('button', { name: 'Conferir importação diária pendente' })).toHaveCount(0); expect(seen.payments).toEqual([]);
});
for (const malformed of ['hash', 'count', 'date', 'partition', 'version', 'financial', 'rounding'] as const) test(`resposta de preparação inválida (${malformed}) não grava`, async ({ page }) => {
  const seen = await setup(page, { malformed }); await selectFile(page, malformed === 'rounding' ? dailyCsv.replace('1.234,56', '3.122,935') : dailyCsv);
  await expect(page.getByRole('alert')).toBeVisible(); await importButton(page).click(); await expect(page.getByRole('alert')).toBeVisible(); expect(seen.commits).toEqual([]); expect(seen.payments).toEqual([]);
});
test('processamento pendente impede trocar de arquivo e favorecidos são texto', async ({ page }) => {
  const seen = await setup(page, { deferred: true }); await selectFile(page, dailyCsv.replace('Fornecedor sintético', '<script>window.dailyExecuted=true</script>')); await expect(page.getByRole('status')).toContainText('Preparando relatório'); await expect(page.getByLabel('Relatório completo diário de Contas a Pagar')).toBeDisabled();
  seen.release(); await expect(importButton(page)).toBeEnabled(); expect(await page.evaluate(() => (window as any).dailyExecuted)).toBeUndefined(); await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
