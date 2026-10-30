import { test, expect } from '@playwright/test';
import { dailyBank, dailyOtherBank, dailyChequeBank, dailyBankKey, dailyChequeCsv, dailyCsv, dailyDate, setupDailyImport as setup, selectDailyFile as selectFile } from './helpers/payable-daily-import';

const finish = 'Importar e conciliar relatório diário';
test('selecionar o relatório completo inicia uma única prévia e uma confirmação aplica a baixa no vencimento', async ({ page }) => {
  const seen = await setup(page); await selectFile(page);
  await expect(page.getByRole('heading', { name: 'Conferência da importação diária' })).toBeVisible();
  await expect(page.getByText('A primeira conferência diária compara este relatório', { exact: false })).toBeVisible();
  await expect(page.getByRole('table', { name: '1 título(s) com baixa automática' })).toContainText('16/10/2026');
  expect(seen.previews).toHaveLength(1); expect(seen.commits).toHaveLength(0); expect(seen.payments).toHaveLength(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('todos os títulos comuns em aberto de todas as filiais'); expect(dialog.message()).toContain('respectivas datas de vencimento'); return dialog.accept(); });
  await page.getByRole('button', { name: finish, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Importação diária concluída.');
  expect(seen.commits).toHaveLength(1); expect(seen.commits[0]).toMatchObject({ mode: 'daily', daily_report_version: '059', report_kind: 'NORMAL', expected_report_date: dailyDate, complete: true, resolution_choices: {} });
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
  const seen = await setup(page); await selectFile(page, dailyChequeCsv, true);
  const bank = page.getByLabel('Banco efetivo da baixa AUSENTE-1 filial 3', { exact: true });
  await expect(bank).toHaveValue(dailyChequeBank.id); await expect(bank).toBeDisabled();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Importação diária concluída.'); expect(seen.payments[0].bank).toBe(dailyChequeBank.id);
});
test('relatório global atualiza a previsão dos cheques sem baixá-los pela ausência dos títulos comuns', async ({ page }) => {
  const seen = await setup(page); await selectFile(page, `${dailyCsv}\r\n15;Cheque sintético;20/10/2026;500,00;ENERGIA;Banco sintético;3;CHEQUE;000123`);
  await expect(page.getByText('A previsão dos cheques presentes também será atualizada', { exact: false })).toBeVisible();
  const preview = page.getByRole('table', { name: 'Previsão atualizada · primeiros 2 de 2 lançamentos', exact: true });
  await expect(preview.locator('tbody tr')).toHaveCount(2); await expect(preview).toContainText('Cheque sintético'); await expect(preview).toContainText('Pagamento do cheque: BRADESCO F2G');
  await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  expect(seen.previews).toHaveLength(1); expect(seen.payments).toHaveLength(0);
});
test('primeiro relatório de cheques estabelece a comparação sem baixar ausentes', async ({ page }) => {
  const seen = await setup(page, { firstCheques: true }); await selectFile(page, dailyChequeCsv, true);
  await expect(page.getByText('Primeiro relatório de cheques:', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: finish })).toBeEnabled(); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click();
  await expect(page.getByRole('status')).toContainText('0 pagamento(s)'); expect(seen.payments).toEqual([]); expect(seen.commits[0].report_kind).toBe('CHEQUES');
});
test('primeira posição de cheques vazia exige declaração e cria somente a referência inicial', async ({ page }) => {
  const seen = await setup(page, { firstCheques: true }); await selectFile(page, dailyChequeCsv.split('\r\n')[0], true);
  await expect(page.getByRole('table', { name: 'Pendências do relatório diário' })).toContainText('Não há títulos no relatório'); expect(seen.previews).toHaveLength(0);
  await page.getByLabel('Confirmo que o relatório completo não contém cheques pendentes', { exact: true }).check();
  await expect(page.getByText('Primeiro relatório de cheques:', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Títulos no relatório: 0'); return dialog.accept(); }); await page.getByRole('button', { name: finish }).click(); await expect(page.getByRole('status')).toContainText('0 pagamento(s)'); expect(seen.payments).toEqual([]); expect(seen.commits[0].empty_cheques_confirmed).toBe(true);
});
test('últimos cheques ausentes em posição vazia são pagos na importação e a confirmação incerta mantém a declaração', async ({ page }) => {
  const seen = await setup(page, { automatic: 2, uncertain: true }); await selectFile(page, dailyChequeCsv.split('\r\n')[0], true);
  await page.getByLabel('Confirmo que o relatório completo não contém cheques pendentes', { exact: true }).check(); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  await expect(page.getByRole('table', { name: '2 título(s) com baixa automática' })).toContainText('29/10/2026'); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click();
  await expect(page.getByLabel('Confirmo que o relatório completo não contém cheques pendentes', { exact: true })).toBeDisabled(); await page.getByRole('button', { name: 'Conferir importação diária pendente' }).click(); await expect(page.getByRole('status')).toContainText('Este envio já estava concluído');
  expect(seen.commits[0].empty_cheques_confirmed).toBe(true); expect(seen.commits[1]).toEqual(seen.commits[0]); expect(seen.payments).toHaveLength(2); expect(seen.payments.every(payment => payment.date === dailyDate)).toBe(true);
});
test('declaração de zero cheques invalida a conferência de arquivo preenchido e não reaproveita a leitura anterior', async ({ page }) => {
  const seen = await setup(page); await selectFile(page, dailyChequeCsv, true); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
  await page.getByLabel('Confirmo que o relatório completo não contém cheques pendentes', { exact: true }).check(); await expect(page.getByRole('table', { name: 'Pendências do relatório diário' })).toContainText('Desmarque'); await expect(page.getByRole('button', { name: finish })).toHaveCount(0); expect(seen.previews).toHaveLength(1); expect(seen.commits).toEqual([]);
});
test('cheque ausente tem pagamento no dia da importação, preservando seu vencimento anterior', async ({ page }) => {
  const seen = await setup(page); await selectFile(page, dailyChequeCsv, true);
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
  await expect(page.getByRole('button', { name: 'Relatório diário de cheques', exact: true })).toBeDisabled(); await expect(page.getByLabel('Relatório completo diário de Contas a Pagar')).toBeDisabled(); await expect(page.getByRole('tab', { name: 'Contas a Receber', exact: true })).toBeDisabled(); await expect(page.getByRole('navigation').getByRole('button', { name: 'Painel Gerencial', exact: true })).toBeDisabled(); seen.release(); await expect(page.getByRole('button', { name: finish })).toBeEnabled();
});
for (const option of ['uncertain', 'invalidCommit'] as const) test(`${option}: confirmação pendente congela o mesmo protocolo e repete sem duplicar pagamento`, async ({ page }) => {
  const seen = await setup(page, { [option]: true }); await selectFile(page); await expect(page.getByRole('button', { name: finish })).toBeEnabled(); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click();
  const retry = page.getByRole('button', { name: 'Conferir importação diária pendente' }); await expect(retry).toBeEnabled();
  await expect(page.getByLabel('Relatório completo diário de Contas a Pagar')).toBeDisabled(); await expect(page.getByRole('button', { name: 'Relatório diário de cheques', exact: true })).toBeDisabled(); await expect(page.getByRole('tab', { name: 'Contas a Receber', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeDisabled();
  await retry.click(); await expect(page.getByRole('status')).toContainText('Este envio já estava concluído, sem duplicar baixas.'); expect(seen.commits).toHaveLength(2); expect(seen.commits[1]).toEqual(seen.commits[0]); expect(seen.payments).toHaveLength(1); expect(seen.previews).toHaveLength(1);
});
test('conflito de revisão mantém o arquivo e exige nova conferência, sem pagamento', async ({ page }) => {
  const seen = await setup(page, { stale: true }); await selectFile(page); await expect(page.getByRole('button', { name: finish })).toBeEnabled(); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: finish }).click(); await expect(page.getByRole('alert')).toContainText('A base ou o dia da importação mudou'); await expect(page.getByRole('button', { name: finish })).toBeDisabled(); await expect(page.getByLabel('Relatório completo diário de Contas a Pagar')).toHaveValue(/diario.csv$/); expect(seen.payments).toEqual([]);
});
test('baixas são paginadas sem ocultar a soma e os favorecidos são tratados como texto', async ({ page }) => {
  await setup(page, { automatic: 30 }); await selectFile(page, dailyCsv.replace('Fornecedor sintético', '<script>window.dailyExecuted=true</script>'));
  await expect(page.getByRole('table', { name: '30 título(s) com baixa automática' }).locator('tbody tr')).toHaveCount(25); await page.getByRole('button', { name: 'Próximas baixas', exact: true }).click(); await expect(page.getByRole('table', { name: '30 título(s) com baixa automática' }).locator('tbody tr')).toHaveCount(5); expect(await page.evaluate(() => (window as any).dailyExecuted)).toBeUndefined(); await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
