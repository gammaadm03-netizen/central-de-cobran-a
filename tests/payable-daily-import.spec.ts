import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import { dailyBank, dailyOtherBank, dailyChequeBank, dailyBankKey, dailyChequeCsv, dailyCsv, dailyDate, setupDailyImport as setup, selectDailyFile as selectFile } from './helpers/payable-daily-import';

const finish = 'Importar e conciliar relatório diário';
test('reenviar o relatório atual sem mudanças registra a posição sem duplicar títulos ou pagamentos', async ({ page }) => {
  const seen = await setup(page); await selectFile(page); await expect(page.getByRole('button', { name: finish, exact: true })).toBeEnabled();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Importação diária concluída.'); expect(seen.payments).toHaveLength(1);
  await selectFile(page); await expect(page.getByRole('button', { name: finish, exact: true })).toBeEnabled();
  await expect(page.getByRole('table', { name: '1 título(s) com baixa automática', exact: true })).toHaveCount(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Pagamentos: 0'); return dialog.accept(); }); await page.getByRole('button', { name: finish, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('0 pagamento(s)'); expect(seen.payments).toHaveLength(1); expect(seen.commits).toHaveLength(2);
  expect(seen.commits[0].file_base64).toBe(seen.commits[1].file_base64); expect(seen.commits[0].request_id).not.toBe(seen.commits[1].request_id);
});
test('o mesmo relatório baixa ausentes comuns no vencimento e cheques no dia da importação', async ({ page }) => {
  const seen = await setup(page, { automatic: 2, mixedMissing: true }); await selectFile(page);
  const table = page.getByRole('table', { name: '2 título(s) com baixa automática', exact: true });
  await expect(table.locator('tbody tr').nth(0)).toContainText('16/10/2026');
  await expect(table.locator('tbody tr').nth(1)).toContainText('29/10/2026');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('2 pagamento(s)');
  expect(seen.commits).toHaveLength(1); expect(seen.commits[0].report_kind).toBe('ALL');
  expect(seen.payments).toEqual([{ title_id: expect.any(String), amount: 10000, date: '2026-10-16', bank: dailyBank.id }, { title_id: expect.any(String), amount: 10001, date: dailyDate, bank: dailyChequeBank.id }]);
});
test('XLSX da origem mantém plano CP, banco previsto, emissão, vencimento, centavos e zeros do cheque', async ({ page }) => {
  const seen = await setup(page, { firstReport: true }), book = new ExcelJS.Workbook(), sheet = book.addWorksheet('CP');
  sheet.addRow(['Lançamento', 'Histórico', 'Plano cp - Conta: nome', 'Plano cc - Conta: nome', 'Emissão: valor do lançamento', 'Emissão: data', 'Vencimento: data', 'Filial', 'Cheque: número']);
  sheet.addRow(['ERP-14', 'Fornecedor - parcela 2/6', 'ENERGIA', 'Banco previsto sintético', 1234.56, new Date('2026-10-01T15:03:00Z'), new Date('2026-10-16T00:00:00Z'), '3', 719]);
  sheet.getCell('F2').numFmt = 'dd/mm/yyyy hh:mm'; sheet.getCell('G2').numFmt = 'dd/mm/yyyy'; sheet.getCell('I2').numFmt = '000000';
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  await page.getByLabel('Relatório completo diário de Contas a Pagar', { exact: true }).setInputFiles({ name: 'cp.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
  const preview = page.getByRole('table', { name: 'Previsão atualizada · primeiros 1 de 1 lançamentos', exact: true });
  for (const value of ['ERP-14', 'Fornecedor - parcela 2/6', 'ENERGIA', 'Banco previsto sintético', 'R$ 1.234,56', '01/10/2026', '16/10/2026', '000719']) await expect(preview).toContainText(value);
  await expect(page.getByRole('button', { name: finish, exact: true })).toBeEnabled();
  expect(Buffer.from(seen.previews[0].file_base64, 'base64')).toEqual(bytes); expect(seen.previews[0]).not.toHaveProperty('rows'); expect(seen.payments).toEqual([]);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
});
test('linha inválida informa o problema antes de enviar qualquer análise financeira', async ({ page }) => {
  const seen = await setup(page); await selectFile(page, dailyCsv.replace('16/10/2026', '31/02/2026'));
  await expect(page.getByRole('table', { name: 'Pendências do relatório diário', exact: true })).toContainText('Data inexistente.');
  await expect(page.getByRole('button', { name: finish, exact: true })).toHaveCount(0); expect(seen.previews).toEqual([]); expect(seen.commits).toEqual([]);
});
test('trocar o arquivo descarta a análise anterior e exige conferir os novos valores', async ({ page }) => {
  const seen = await setup(page, { firstReport: true }); await selectFile(page); await expect(page.getByRole('button', { name: finish, exact: true })).toBeEnabled();
  await selectFile(page, dailyCsv.replace('1.234,56', '2.345,67'));
  await expect(page.getByRole('table', { name: 'Previsão atualizada · primeiros 1 de 1 lançamentos', exact: true })).toContainText('R$ 2.345,67');
  expect(seen.previews).toHaveLength(2); expect(seen.previews[0].file_base64).not.toBe(seen.previews[1].file_base64); expect(seen.commits).toEqual([]);
});
test('atualização060 ausente explica a ativação sem mostrar uma confirmação pendente', async ({ page }) => {
  const seen = await setup(page, { activationRequired: true }); await selectFile(page);
  await expect(page.getByRole('alert')).toContainText('060'); await expect(page.getByRole('button', { name: finish, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Conferir importação diária pendente', exact: true })).toHaveCount(0); expect(seen.commits).toEqual([]);
});
test('a importação tem um único arquivo diário sem etapas de previsão, pagos ou cheques separados', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('heading', { name: 'Contas a Pagar: um relatório por dia', exact: true })).toBeVisible();
  await expect(page.getByLabel('Relatório completo diário de Contas a Pagar', { exact: true })).toHaveCount(1);
  for (const name of ['Relatório diário de títulos', 'Relatório diário de cheques', 'Previsões / novos títulos', 'Pagamentos realizados']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
});
test('selecionar o relatório completo inicia uma única prévia e uma confirmação aplica a baixa no vencimento', async ({ page }) => {
  const seen = await setup(page); await selectFile(page);
  await expect(page.getByRole('heading', { name: 'Conferência da importação diária' })).toBeVisible();
  await expect(page.getByText('Primeiro relatório:', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('table', { name: '1 título(s) com baixa automática' })).toContainText('16/10/2026');
  expect(seen.previews).toHaveLength(1); expect(seen.commits).toHaveLength(0); expect(seen.payments).toHaveLength(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('todos os títulos em aberto de todas as filiais, incluindo os cheques'); expect(dialog.message()).toContain('títulos comuns na data de vencimento'); return dialog.accept(); });
  await page.getByRole('button', { name: finish, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Importação diária concluída.');
  expect(seen.commits).toHaveLength(1); expect(seen.commits[0]).toMatchObject({ mode: 'daily', daily_report_version: '060', report_kind: 'ALL', expected_report_date: dailyDate, complete: true, resolution_choices: {} });
  expect(Buffer.from(seen.commits[0].file_base64, 'base64').toString('utf8')).toBe(dailyCsv);
  expect(seen.payments).toEqual([{ title_id: expect.any(String), amount: 10000, date: '2026-10-16', bank: dailyBank.id }]); expect(seen.otherWrites).toEqual([]);
});
test('cancelar a confirmação preserva a conferência sem aplicar pagamentos', async ({ page }) => {
  const seen = await setup(page); await selectFile(page); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: finish }).click(); expect(seen.commits).toHaveLength(0); expect(seen.payments).toHaveLength(0);
});
test('banco efetivo de baixa comum pode mudar após nova conferência, preservando data e banco previsto', async ({ page }) => {
  const seen = await setup(page); await selectFile(page);
  const preview = page.getByRole('table', { name: 'Previsão atualizada · primeiros 1 de 1 lançamentos', exact: true });
  await expect(preview).toContainText('Banco sintético');
  await page.getByLabel('Banco efetivo da baixa AUSENTE-1 filial 3', { exact: true }).selectOption(dailyOtherBank.id);
  await expect(page.getByRole('button', { name: finish, exact: true })).toBeDisabled(); expect(seen.payments).toEqual([]);
  await page.getByRole('button', { name: 'Conferir ajustes do relatório diário', exact: true }).click();
  await expect(page.getByRole('button', { name: finish, exact: true })).toBeEnabled();
  expect(Object.values(seen.previews.at(-1).resolution_choices)).toEqual([expect.objectContaining({ action: 'PAID', paid_on: '2026-10-16', bank_account_id: dailyOtherBank.id, amount_paid_cents: 10000 })]);
  await expect(preview).toContainText('Banco sintético');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Importação diária concluída.');
  expect(seen.payments).toEqual([{ amount: 10000, date: '2026-10-16', bank: dailyOtherBank.id }]);
  expect(seen.commits[0].bank_mappings).toEqual({});
});
test('banco efetivo de cheque com número fica fixo em BRADESCO F2G', async ({ page }) => {
  const seen = await setup(page, { chequeMissing: true }); await selectFile(page, dailyChequeCsv, true);
  const bank = page.getByLabel('Banco efetivo da baixa AUSENTE-1 filial 3', { exact: true });
  await expect(bank).toHaveValue(dailyChequeBank.id); await expect(bank).toBeDisabled();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Importação diária concluída.'); expect(seen.payments[0].bank).toBe(dailyChequeBank.id);
});
test('relatório único inclui títulos comuns e cheques na mesma previsão', async ({ page }) => {
  const seen = await setup(page); await selectFile(page, `${dailyCsv}\r\n15;Cheque sintético;20/10/2026;500,00;ENERGIA;Banco sintético;3;CHEQUE;000123`);
  const preview = page.getByRole('table', { name: 'Previsão atualizada · primeiros 2 de 2 lançamentos', exact: true });
  await expect(preview.locator('tbody tr')).toHaveCount(2); await expect(preview).toContainText('Cheque sintético'); await expect(preview).toContainText('Pagamento do cheque: BRADESCO F2G');
  await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  expect(seen.previews).toHaveLength(1); expect(seen.payments).toHaveLength(0);
});
test('primeiro relatório cria a base inicial sem presumir pagamentos de títulos ausentes', async ({ page }) => {
  const seen = await setup(page, { firstReport: true }); await selectFile(page, dailyChequeCsv, true);
  await expect(page.getByText('Primeiro relatório:', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: finish })).toBeEnabled(); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click();
  await expect(page.getByRole('status')).toContainText('0 pagamento(s)'); expect(seen.payments).toEqual([]); expect(seen.commits[0].report_kind).toBe('ALL');
});
test('primeira posição vazia exige declaração e cria somente a referência inicial', async ({ page }) => {
  const seen = await setup(page, { firstReport: true }); await selectFile(page, dailyChequeCsv.split('\r\n')[0], true);
  await expect(page.getByRole('table', { name: 'Pendências do relatório diário' })).toContainText('Não há títulos no relatório'); expect(seen.previews).toHaveLength(0);
  await page.getByLabel('Confirmo que o relatório completo não contém títulos em aberto', { exact: true }).check();
  await expect(page.getByText('Primeiro relatório:', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Títulos no relatório: 0'); return dialog.accept(); }); await page.getByRole('button', { name: finish }).click(); await expect(page.getByRole('status')).toContainText('0 pagamento(s)'); expect(seen.payments).toEqual([]); expect(seen.commits[0].empty_report_confirmed).toBe(true);
});
test('últimos cheques ausentes em posição vazia são pagos na importação e a confirmação incerta mantém a declaração', async ({ page }) => {
  const seen = await setup(page, { automatic: 2, uncertain: true, chequeMissing: true }); await selectFile(page, dailyChequeCsv.split('\r\n')[0], true);
  await page.getByLabel('Confirmo que o relatório completo não contém títulos em aberto', { exact: true }).check(); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  await expect(page.getByRole('table', { name: '2 título(s) com baixa automática' })).toContainText('29/10/2026'); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click();
  await expect(page.getByLabel('Confirmo que o relatório completo não contém títulos em aberto', { exact: true })).toBeDisabled(); await page.getByRole('button', { name: 'Conferir importação diária pendente' }).click(); await expect(page.getByRole('status')).toContainText('Este envio já estava concluído');
  expect(seen.commits[0].empty_report_confirmed).toBe(true); expect(seen.commits[1]).toEqual(seen.commits[0]); expect(seen.payments).toHaveLength(2); expect(seen.payments.every(payment => payment.date === dailyDate)).toBe(true);
});
test('declaração de posição vazia invalida o arquivo preenchido sem reaproveitar a conferência anterior', async ({ page }) => {
  const seen = await setup(page, { chequeMissing: true }); await selectFile(page, dailyChequeCsv, true); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  await page.getByLabel('Confirmo que o relatório completo não contém títulos em aberto', { exact: true }).check(); await expect(page.getByRole('table', { name: 'Pendências do relatório diário' })).toContainText('Desmarque'); await expect(page.getByRole('button', { name: finish })).toHaveCount(0); expect(seen.previews).toHaveLength(1); expect(seen.commits).toEqual([]);
});
test('cheque ausente tem pagamento no dia da importação, preservando seu vencimento anterior', async ({ page }) => {
  const seen = await setup(page, { chequeMissing: true }); await selectFile(page, dailyChequeCsv, true);
  const table = page.getByRole('table', { name: '1 título(s) com baixa automática' }); await expect(table).toContainText('29/10/2026'); await expect(table).toContainText('16/10/2026');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click(); await expect(page.getByRole('status')).toContainText('Importação diária concluída.');
  expect(seen.payments[0].date).toBe(dailyDate); expect(seen.commits[0].expected_report_date).toBe(dailyDate);
});
test('banco desconhecido pede apenas a exceção e grava pagamento integral na conta escolhida', async ({ page }) => {
  const seen = await setup(page, { unknownBank: true }); await selectFile(page); await expect(page.getByRole('button', { name: finish })).toBeDisabled();
  await page.getByLabel('Exceção diária do lançamento AUSENTE-1 filial 3').selectOption('PAID');
  await expect(page.getByLabel('Valor diário do lançamento AUSENTE-1 filial 3')).toHaveValue('100,00'); await expect(page.getByLabel('Valor diário do lançamento AUSENTE-1 filial 3')).not.toBeEditable();
  await page.getByLabel('Conta diária do lançamento AUSENTE-1 filial 3').selectOption(dailyBank.id);
  await page.getByRole('button', { name: 'Conferir ajustes do relatório diário' }).click(); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click(); await expect(page.getByRole('status')).toContainText('1 pagamento(s)'); expect(seen.payments[0]).toMatchObject({ amount: 10000, date: '2026-10-16', bank: dailyBank.id });
});
test('vencimento futuro exige confirmar a data efetiva antes de gerar realizado', async ({ page }) => {
  const seen = await setup(page, { futureDue: true }); await selectFile(page);
  await page.getByLabel('Exceção diária do lançamento AUSENTE-1 filial 3').selectOption('PAID');
  await page.getByLabel('Data diária do lançamento AUSENTE-1 filial 3').fill('2026-10-28'); await page.getByRole('button', { name: 'Conferir ajustes do relatório diário' }).click();
  await expect(page.getByRole('button', { name: finish })).toBeEnabled(); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click(); await expect(page.getByRole('status')).toContainText('Importação diária concluída.'); expect(seen.payments[0].date).toBe('2026-10-28');
});
test('uma escolha de conta vincula vários títulos e fica congelada na repetição do mesmo protocolo', async ({ page }) => {
  const seen = await setup(page, { unknownBank: true, unknownBankCount: 2, uncertain: true }); await selectFile(page);
  const account = page.getByLabel('Vincular conta para Banco sintético · Filial 3', { exact: true }); await expect(account).toHaveCount(1);
  await expect(page.getByText('usará este vínculo nas próximas importações desta descrição e filial', { exact: false })).toBeVisible();
  await account.selectOption(dailyBank.id); await page.getByRole('button', { name: 'Conferir ajustes do relatório diário' }).click();
  await expect(page.getByRole('button', { name: finish })).toBeEnabled(); await expect(page.getByRole('table', { name: '2 título(s) com baixa automática' }).locator('tbody tr')).toHaveCount(2);
  expect(seen.previews.at(-1).resolution_choices).toEqual({}); expect(seen.previews.at(-1).bank_mappings).toEqual({ [dailyBankKey]: dailyBank.id });
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click(); await page.getByRole('button', { name: 'Conferir importação diária pendente' }).click(); await expect(page.getByRole('status')).toContainText('Este envio já estava concluído');
  expect(seen.commits[1]).toEqual(seen.commits[0]); expect(seen.commits[0].bank_mappings).toEqual({ [dailyBankKey]: dailyBank.id }); expect(seen.payments).toHaveLength(2);
});
test('cada centavo exige confirmação individual e fica fora dos pagamentos', async ({ page }) => {
  const seen = await setup(page, { automatic: 0 }); await selectFile(page, `${dailyCsv.replace('1.234,56', '0,01')}\r\n15;Outro marcador;20/10/2026;0,01;ENERGIA;Banco sintético;3;ABERTO;`);
  await page.getByLabel('Confirmar baixa diária de R$ 0,01 do lançamento 14 filial 3').check(); await page.getByRole('button', { name: 'Conferir ajustes do relatório diário' }).click(); await expect(page.getByRole('button', { name: finish })).toBeDisabled();
  await page.getByLabel('Confirmar baixa diária de R$ 0,01 do lançamento 15 filial 3').check(); await page.getByRole('button', { name: 'Conferir ajustes do relatório diário' }).click(); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click(); await expect(page.getByRole('status')).toContainText('2 baixa(s) de R$ 0,01 sem pagamento'); expect(seen.payments).toEqual([]); expect(seen.writeoffs).toHaveLength(2);
});
test('marcador de centavo preserva nominal anterior e continua oferecendo somente baixa individual', async ({ page }) => {
  const seen = await setup(page, { automatic: 0, centNominal: 54321 }); await selectFile(page, dailyCsv.replace('1.234,56', '0,01'));
  await expect(page.getByText('Valor do relatório sem os marcadores de R$ 0,01: R$ 0,00', { exact: true })).toBeVisible();
  await expect(page.getByText('Valor R$ 543,21', { exact: false })).toBeVisible(); await expect(page.getByLabel('Exceção diária do lançamento 14 filial 3')).toHaveCount(0);
  await page.getByLabel('Confirmar baixa diária de R$ 0,01 do lançamento 14 filial 3').check(); await page.getByRole('button', { name: 'Conferir ajustes do relatório diário' }).click(); await expect(page.getByRole('button', { name: finish })).toBeEnabled(); expect(seen.payments).toEqual([]);
});
test('título que reaparece pago permanece bloqueado para correção explícita do histórico', async ({ page }) => {
  const seen = await setup(page, { automatic: 0, paidReappeared: true }); await selectFile(page); await expect(page.getByText('Este título exige correção no histórico antes de concluir', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: finish })).toBeDisabled(); expect(seen.commits).toEqual([]);
});
test('classificações existentes são reaproveitadas e somente plano novo exige escolha', async ({ page }) => {
  const seen = await setup(page, { unclassified: true }); await selectFile(page); await page.getByLabel('Macro diário para ENERGIA').selectOption('FIXO'); await page.getByRole('button', { name: 'Conferir ajustes do relatório diário' }).click(); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  expect(seen.previews.at(-1).mappings).toEqual({ ENERGIA: 'FIXO' }); await expect(page.getByLabel('Macro diário para ENERGIA')).toHaveCount(0);
});
for (const malformed of ['hash', 'count', 'date', 'partition', 'automatic-date', 'automatic-bank', 'version'] as const) test(`resposta ${malformed} inválida impede a confirmação financeira`, async ({ page }) => {
  const seen = await setup(page, { malformed }); await selectFile(page); await expect(page.getByRole('alert')).toContainText('Não foi possível conferir o relatório diário'); await expect(page.getByRole('button', { name: finish })).toHaveCount(0); expect(seen.commits).toEqual([]); expect(seen.payments).toEqual([]);
});
test('prévia em andamento bloqueia troca de arquivo, base e navegação', async ({ page }) => {
  const seen = await setup(page, { deferred: true }); await selectFile(page); await expect(page.getByText('Conferindo o relatório e calculando as baixas…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Relatório diário de cheques', exact: true })).toHaveCount(0); await expect(page.getByLabel('Relatório completo diário de Contas a Pagar')).toBeDisabled(); await expect(page.getByRole('tab', { name: 'Contas a Receber', exact: true })).toBeDisabled(); await expect(page.getByRole('navigation').getByRole('button', { name: 'Painel Gerencial', exact: true })).toBeDisabled(); seen.release(); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
});
for (const option of ['uncertain', 'invalidCommit'] as const) test(`${option}: confirmação pendente congela o mesmo protocolo e repete sem duplicar pagamento`, async ({ page }) => {
  const seen = await setup(page, { [option]: true }); await selectFile(page); await expect(page.getByRole('button', { name: finish })).toBeEnabled(); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click();
  const retry = page.getByRole('button', { name: 'Conferir importação diária pendente' }); await expect(retry).toBeEnabled();
  await expect(page.getByLabel('Relatório completo diário de Contas a Pagar')).toBeDisabled(); await expect(page.getByRole('button', { name: 'Relatório diário de cheques', exact: true })).toHaveCount(0); await expect(page.getByRole('tab', { name: 'Contas a Receber', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeDisabled();
  await retry.click(); await expect(page.getByRole('status')).toContainText('Este envio já estava concluído, sem duplicar baixas.'); expect(seen.commits).toHaveLength(2); expect(seen.commits[1]).toEqual(seen.commits[0]); expect(seen.payments).toHaveLength(1); expect(seen.previews).toHaveLength(1);
});
test('conflito de revisão mantém o arquivo e exige nova conferência, sem pagamento', async ({ page }) => {
  const seen = await setup(page, { stale: true }); await selectFile(page); await expect(page.getByRole('button', { name: finish })).toBeEnabled(); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click(); await expect(page.getByRole('alert')).toContainText('A base ou o dia da importação mudou'); await expect(page.getByRole('button', { name: finish })).toBeDisabled(); await expect(page.getByLabel('Relatório completo diário de Contas a Pagar')).toHaveValue(/diario.csv$/); expect(seen.payments).toEqual([]);
});
test('baixas são paginadas sem ocultar a soma e os favorecidos são tratados como texto', async ({ page }) => {
  await setup(page, { automatic: 30 }); await selectFile(page, dailyCsv.replace('Fornecedor sintético', '<script>window.dailyExecuted=true</script>'));
  await expect(page.getByRole('table', { name: '30 título(s) com baixa automática' }).locator('tbody tr')).toHaveCount(25); await page.getByRole('button', { name: 'Próximas baixas', exact: true }).click(); await expect(page.getByRole('table', { name: '30 título(s) com baixa automática' }).locator('tbody tr')).toHaveCount(5); expect(await page.evaluate(() => (window as any).dailyExecuted)).toBeUndefined(); await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
