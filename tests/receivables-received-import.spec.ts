import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { setupReceivableImport as setup, analyzeReceivableImport as analyze, receivedCsv, openCsv } from './helpers/receivable-import';

async function receivedMode(page: Page) { await page.getByRole('button', { name: 'Títulos quitados', exact: true }).click(); }

test('quitados exibem nominal e efetivo separados e confirmam o arquivo uma vez para recebimentos e base de comissões', async ({ page }) => {
  const seen = await setup(page); await receivedMode(page); await analyze(page, receivedCsv, 'received');
  await expect(page.getByText('Total recebido efetivo: R$ 1.200,00', { exact: true })).toBeVisible();
  await expect(page.getByText('total original R$ 1.234,56', { exact: false })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Vencimento original', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Recebido em', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '16/10/2026', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '17/10/2026', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Confirmar importação de títulos quitados' }).click(); expect(seen.commits).toHaveLength(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('sairão da carteira ativa'); expect(dialog.message()).toContain('base de apuração de comissões'); expect(dialog.message()).toContain('Esta importação não paga comissões'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Confirmar importação de títulos quitados' }).click();
  await expect(page.getByRole('status')).toContainText('títulos validados fora da carteira ativa');
  expect(seen.commits).toEqual([{ action: 'commit', mode: 'received', file_name: 'cr.csv', file_base64: Buffer.from(receivedCsv).toString('base64'), complete: true, title_mappings: {}, previous_import_id: null, previous_financial_revision: '17', confirm_corrections: false }]);
  expect(seen.financialWrites).toEqual([]);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
});
test('quitados sem dados efetivos bloqueiam no navegador sem assumir vencimento como recebimento', async ({ page }) => {
  const seen = await setup(page); await receivedMode(page); await analyze(page, openCsv, 'received');
  await expect(page.getByRole('cell', { name: 'Quitação: data do recebimento', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Quitação: valor recebido', exact: true })).toBeVisible();
  expect(seen.previews).toHaveLength(0); expect(seen.commits).toHaveLength(0);
});
test('ajuste de recebimento importado usa consentimento único do arquivo e preserva os registros anteriores', async ({ page }) => {
  const seen = await setup(page, { correction: true }); await receivedMode(page); await analyze(page, receivedCsv, 'received');
  await expect(page.getByRole('cell', { name: 'Corrigir recebimento importado', exact: true })).toBeVisible();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('1 correções de recebimentos importados'); expect(dialog.message()).toContain('Correções preservam os registros anteriores'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Confirmar importação de títulos quitados' }).click();
  await expect(page.getByRole('status')).toContainText('Importação concluída'); expect(seen.commits[0].confirm_corrections).toBe(true);
});
test('recebimento já identificado é reaproveitado e quitado antigo pode entrar como histórico', async ({ page }) => {
  const seen = await setup(page, { historical: true }); await receivedMode(page); await analyze(page, receivedCsv, 'received');
  await expect(page.getByRole('cell', { name: 'Incluir quitado do histórico', exact: true })).toBeVisible();
  await expect(page.getByText('1 quitados do histórico.', { exact: false })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar importação de títulos quitados' }).click();
  await expect(page.getByRole('status')).toContainText('Importação concluída'); expect(seen.commits).toHaveLength(1);
});
test('recebimento manual divergente bloqueia o lote inteiro sem substituir lançamento financeiro', async ({ page }) => {
  const seen = await setup(page, { conflict: true }); await receivedMode(page); await analyze(page, receivedCsv, 'received');
  await expect(page.getByRole('cell', { name: 'Recebimento manual divergente. Nenhum registro será substituído.', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Recebimento manual divergente. Nenhum registro será substituído.', exact: true }) }).getByRole('cell').first()).toHaveText('2');
  await expect(page.getByRole('button', { name: 'Confirmar importação de títulos quitados' })).toBeDisabled(); expect(seen.commits).toHaveLength(0);
});
test('quitado de parcela diferente usa Nova parcela explícita antes de criar histórico', async ({ page }) => {
  const seen = await setup(page, { ambiguous: 1 }); await receivedMode(page); await analyze(page, receivedCsv, 'received');
  await expect(page.getByRole('button', { name: 'Confirmar importação de títulos quitados' })).toBeDisabled();
  await page.getByLabel('Vínculo da linha 2', { exact: true }).selectOption('NEW');
  await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Incluir quitado do histórico', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar importação de títulos quitados' }).click();
  await expect(page.getByRole('status')).toContainText('Importação concluída'); expect(seen.commits[0].title_mappings).toEqual({ '1': 'NEW' });
});
test('resultado incerto preserva arquivo e modo para repetir o mesmo envio sem duplicar recebimentos', async ({ page }) => {
  const seen = await setup(page, { uncertainCommit: true }); await receivedMode(page); await analyze(page, receivedCsv, 'received');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar importação de títulos quitados' }).click();
  await expect(page.getByText('A confirmação está pendente.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abertos e vencidos', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Relatório de títulos quitados de Contas a Receber', { exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox')).toBeDisabled();
  await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click(); await expect(page.getByRole('cell', { name: 'Já identificado', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar importação de títulos quitados' }).click();
  await expect(page.getByRole('status')).toContainText('Importação concluída');
  expect(seen.commits).toHaveLength(2); expect(seen.commits[1].file_base64).toBe(seen.commits[0].file_base64);
  await expect(page.getByRole('button', { name: 'Abertos e vencidos', exact: true })).toBeEnabled();
});
test('envio em andamento bloqueia mudanças de arquivo e tipo de relatório até a resposta', async ({ page }) => {
  const seen = await setup(page, { deferCommit: true }); await receivedMode(page); await analyze(page, receivedCsv, 'received');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar importação de títulos quitados' }).click();
  await expect(page.getByRole('button', { name: 'Concluindo importação…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Abertos e vencidos', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Relatório de títulos quitados de Contas a Receber', { exact: true })).toBeDisabled();
  seen.releaseCommit(); await expect(page.getByRole('status')).toContainText('Importação concluída');
});
test('trocar o tipo de relatório limpa arquivo, declaração e análise anteriores', async ({ page }) => {
  await setup(page); await analyze(page); await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber' })).toBeVisible();
  await receivedMode(page); await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber' })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).not.toBeChecked(); await expect(page.getByLabel('Relatório de títulos quitados de Contas a Receber', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Analisar arquivo', exact: true })).toBeDisabled();
});
test('planilha XLSX quitada conserva NF formatada, valor e datas efetivas do ERP', async ({ page }) => {
  const seen = await setup(page); await receivedMode(page);
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Quitados');
  sheet.addRow(['Documento: número', 'Entidade 1 - Entidade: nome', 'Filial', 'Vencimento: data', 'Emissão: valor do lançamento', 'Quitação: data do recebimento', 'Quitação: valor recebido']);
  sheet.addRow([14, 'Cliente sintético', '3', new Date('2026-10-16T00:00:00Z'), 1234.56, new Date('2026-10-17T12:30:00Z'), 1200]); sheet.getCell('A2').numFmt = '00000'; sheet.getCell('D2').numFmt = 'dd/mm/yyyy'; sheet.getCell('F2').numFmt = 'dd/mm/yyyy hh:mm';
  await page.getByLabel('Relatório de títulos quitados de Contas a Receber', { exact: true }).setInputFiles({ name: 'quitados.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await book.xlsx.writeBuffer()) });
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Cliente sintético · 00014', exact: true })).toBeVisible();
  await expect(page.getByText('Total recebido efetivo: R$ 1.200,00', { exact: true })).toBeVisible(); expect(seen.previews[0].mode).toBe('received');
});
test('quitados sem ativação mostram orientação e não tentam a importação antiga', async ({ page }) => {
  const seen = await setup(page, { activationMissing: true }); await receivedMode(page); await analyze(page, receivedCsv, 'received');
  await expect(page.getByRole('alert')).toContainText('Ative a atualização de importação de Contas a Receber');
  expect(seen.commits).toHaveLength(0); expect(seen.previews.every(body => body.mode === 'received')).toBe(true);
});
