import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import { setupReceivableImport as setup, analyzeReceivableImport as analyze, openCsv as csv, candidateId } from './helpers/receivable-import';

test('abertos e vencidos exigem declaração do arquivo e preservam ausências sem confirmar recebimento', async ({ page }) => {
  const seen = await setup(page);
  await page.getByLabel('Relatório de abertos e vencidos de Contas a Receber', { exact: true }).setInputFiles({ name: 'cr.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByRole('button', { name: 'Analisar arquivo', exact: true })).toBeDisabled();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber' })).toBeVisible();
  await expect(page.getByText('0 títulos com alterações. Ausências permanecem como estão; nenhum recebimento será confirmado.', { exact: true })).toBeVisible();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Títulos ausentes neste arquivo continuarão como estão'); expect(dialog.message()).toContain('As carteiras e o histórico serão preservados'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' }).click();
  await expect(page.getByRole('status')).toContainText('Nenhum recebimento foi confirmado');
  expect(seen.commits).toEqual([{ action: 'commit', mode: 'open', file_name: 'cr.csv', file_base64: Buffer.from(csv).toString('base64'), complete: true, title_mappings: {}, previous_import_id: null, previous_financial_revision: '17' }]);
  expect(seen.financialWrites).toEqual([]); await expect(page.getByRole('cell', { name: 'cr.csv', exact: true })).toBeVisible();
});
test('CR bloqueia coluna ausente e data inválida antes de enviar a análise ao servidor', async ({ page }) => {
  const seen = await setup(page); await analyze(page, csv.replace('16/10/2026', '31/02/2026'));
  await expect(page.getByRole('alert')).toContainText('Nenhum dado foi alterado'); await expect(page.getByRole('cell', { name: 'Data inexistente.' })).toBeVisible();
  await analyze(page, 'NF;Cliente;Filial;Valor\r\n14;Cliente;3;1,00');
  await expect(page.getByRole('cell', { name: 'Coluna obrigatória ausente.' })).toBeVisible();
  expect(seen.previews).toHaveLength(0); expect(seen.commits).toHaveLength(0);
});
test('XLSX real conserva centavos e zeros formatados da NF sem armazenamento local', async ({ page }) => {
  const seen = await setup(page), workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('CR');
  sheet.addRow(['Documento: número', 'Entidade 1 - Entidade: nome', 'Filial', 'Vencimento: data', 'Emissão: valor do lançamento']);
  sheet.addRow([14, 'Cliente sintético', '3', new Date('2026-10-16T00:00:00Z'), 1234.56]); sheet.getCell('A2').numFmt = '00000'; sheet.getCell('D2').numFmt = 'dd/mm/yyyy';
  const bytes = await workbook.xlsx.writeBuffer(); await page.getByLabel('Relatório de abertos e vencidos de Contas a Receber', { exact: true }).setInputFiles({ name: 'cr.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) });
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber' })).toBeVisible(); await expect(page.getByText('total original R$ 1.234,56', { exact: false })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Cliente sintético · 00014', exact: true })).toBeVisible(); expect(seen.previews).toHaveLength(1);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
});
test('base alterada exige nova análise e preserva o arquivo sem expor detalhes técnicos', async ({ page }) => {
  await setup(page, { stale: true }); await analyze(page); await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' }).click();
  await expect(page.getByRole('alert')).toContainText('A base mudou desde a análise'); await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber' })).toHaveCount(0); await expect(page.getByText('private SQL details')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Analisar arquivo', exact: true })).toBeEnabled();
});
test('erros estruturados do servidor bloqueiam a conclusão sem mostrar stack trace', async ({ page }) => {
  const seen = await setup(page, { serverInvalid: true }); await analyze(page);
  await expect(page.getByRole('cell', { name: 'CNPJ deve conter exatamente 14 dígitos. Não complete zeros automaticamente.' })).toBeVisible(); await expect(page.getByText('private stack trace')).toHaveCount(0);
  await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'CNPJ deve conter exatamente 14 dígitos. Não complete zeros automaticamente.', exact: true }) }).getByRole('cell').first()).toHaveText('2');
  await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' })).toHaveCount(0); expect(seen.commits).toHaveLength(0);
});
test('quitado que reaparece nos abertos continua quitado e não é reaberto', async ({ page }) => {
  const seen = await setup(page, { validatedPresent: true }); await analyze(page);
  await expect(page.getByText('1 título(s) já quitado(s) reaparecem no relatório. A importação não reabre esses títulos.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' })).toBeEnabled(); expect(seen.commits).toHaveLength(0);
});
test('vencimento ambíguo exige vínculo explícito e nova análise antes de atualizar a parcela existente', async ({ page }) => {
  const seen = await setup(page, { ambiguous: 1 }); await analyze(page);
  await expect(page.getByRole('heading', { name: 'Conferir parcelas do mesmo documento' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' })).toBeDisabled();
  await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Escolha o vínculo da parcela antes de importar.', exact: true }) }).getByRole('cell').first()).toHaveText('2');
  await page.getByLabel('Vínculo da linha 2', { exact: true }).selectOption(candidateId);
  await expect(page.getByText('Vínculos alterados.', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' })).toBeDisabled();
  await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click(); await expect(page.getByRole('cell', { name: 'Atualizar título', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' }).click();
  await expect(page.getByRole('status')).toContainText('Importação concluída'); expect(seen.commits[0].title_mappings).toEqual({ '1': candidateId });
});
test('novas parcelas do mesmo documento podem ser declaradas juntas com quantidade visível', async ({ page }) => {
  const seen = await setup(page, { ambiguous: 2 });
  const second = csv.split('\r\n')[1].replace('16/10/2026', '23/10/2026'); await analyze(page, `${csv}\r\n${second}`);
  await page.getByRole('button', { name: 'Marcar 2 linha(s) como novas parcelas', exact: true }).click();
  await expect(page.getByLabel('Vínculo da linha 2', { exact: true })).toHaveValue('NEW'); await expect(page.getByLabel('Vínculo da linha 3', { exact: true })).toHaveValue('NEW');
  await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click(); await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' })).toBeEnabled();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('2 novas parcelas'); return dialog.accept(); }); await page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' }).click();
  await expect(page.getByRole('status')).toContainText('Importação concluída'); expect(seen.commits[0].title_mappings).toEqual({ '1': 'NEW', '2': 'NEW' });
});
for (const options of [{ activationMissing: true }, { legacyPreview: true }, { tamperHash: true }]) {
  test(`abertos não usam a importação antiga ou prova de arquivo inválida: ${Object.keys(options)[0]}`, async ({ page }) => {
    const seen = await setup(page, options); await analyze(page);
    await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' })).toHaveCount(0); expect(seen.commits).toHaveLength(0);
    expect(seen.previews.every(body => body.mode === 'open')).toBe(true);
  });
}
