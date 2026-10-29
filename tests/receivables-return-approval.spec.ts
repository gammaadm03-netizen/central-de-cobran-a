import { test, expect } from '@playwright/test';
import { setupReceivableImport as setup, analyzeReceivableImport as analyze, openCsv as csv } from './helpers/receivable-import';

const approvalRegion = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Retornos para conferência da Gerência', exact: true });
const finish = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Concluir importação de abertos e vencidos', exact: true });

for (const kind of ['VALIDATED', 'RETIRED'] as const) test(`${kind}: Gerência aprova individualmente, reanalisa e só a importação aplica o retorno`, async ({ page }) => {
  const seen = await setup(page, { manager: true, returnLines: [{ line: 1, kind }] }); await analyze(page);
  const approval = approvalRegion(page);
  await expect(approval).toBeVisible(); await expect(finish(page)).toBeDisabled();
  await expect(approval.getByRole('button', { name: 'Aprovar retorno da NF 00014', exact: true })).toBeDisabled();
  await approval.getByRole('textbox', { name: 'Justificativa do retorno da NF 00014', exact: true }).fill('Retorno conferido individualmente com a origem.');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('O retorno e eventual estorno só serão aplicados ao concluir esta importação.'); return dialog.accept(); });
  await approval.getByRole('button', { name: 'Aprovar retorno da NF 00014', exact: true }).click();
  await expect(approval).toContainText('Aprovação registrada');
  await expect(finish(page)).toBeEnabled();
  expect(seen.approvalCalls).toHaveLength(1); expect(seen.previews.length).toBeGreaterThan(1);
  expect(seen.returnApplications).toHaveLength(0); expect(seen.reversedReceiptIds.size).toBe(0); expect(seen.commits).toHaveLength(0);
  expect(seen.receipts.size).toBe(kind === 'VALIDATED' ? 1 : 0);
  await expect(page.getByRole('region', { name: 'Quitados presentes no relatório de abertos', exact: true })).toHaveCount(0);
  page.once('dialog', dialog => {
    expect(dialog.message()).toContain('1 retorno(s) aprovado(s) pela Gerência serão aplicados com esta importação.');
    expect(dialog.message()).not.toContain('permanecerão fora da carteira ativa');
    return dialog.accept();
  });
  await finish(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Importação concluída:' })).toContainText('1 retorno(s) aprovado(s) pela Gerência aplicados com histórico preservado.');
  expect(seen.returnApplications).toHaveLength(1); expect(seen.returnApplications[0].kind).toBe(kind);
  expect(seen.reversedReceiptIds.size).toBe(kind === 'VALIDATED' ? 1 : 0);
  expect(seen.receipts.size).toBe(kind === 'VALIDATED' ? 1 : 0); // histórico preservado
  expect(seen.financialWrites).toEqual([]); expect(seen.commits).toHaveLength(1);
});

test('Contas a Receber não pode aprovar nem concluir retornos; nenhuma escolha vira nova parcela', async ({ page }) => {
  const seen = await setup(page, { returnLines: [{ line: 1, kind: 'RETIRED' }] }); await analyze(page);
  const approval = approvalRegion(page);
  await expect(approval).toContainText('Conferência da Gerência necessária');
  await expect(approval.getByRole('textbox')).toHaveCount(0); await expect(approval.getByRole('button')).toHaveCount(0);
  await expect(finish(page)).toBeDisabled();
  expect(seen.approvalCalls).toHaveLength(0); expect(seen.returnApplications).toHaveLength(0); expect(seen.commits).toHaveLength(0);
});

test('cada retorno exige sua aprovação, sem ação em lote e sem estorno ao aprovar o primeiro', async ({ page }) => {
  const seen = await setup(page, { manager: true, returnLines: [{ line: 1, kind: 'VALIDATED' }, { line: 2, kind: 'RETIRED' }] });
  const second = csv.split('\r\n')[1].replace('00014;', '00015;'); await analyze(page, `${csv}\r\n${second}`);
  const approval = approvalRegion(page);
  await expect(approval.getByRole('button', { name: /^Aprovar retorno da NF/ })).toHaveCount(2);
  await approval.getByRole('textbox', { name: 'Justificativa do retorno da NF 00014', exact: true }).fill('Primeira parcela conferida.');
  page.once('dialog', dialog => dialog.accept()); await approval.getByRole('button', { name: 'Aprovar retorno da NF 00014', exact: true }).click();
  await expect(approval).toContainText('Aprovação registrada'); await expect(finish(page)).toBeDisabled();
  expect(seen.approvalCalls).toHaveLength(1); expect(seen.returnApplications).toHaveLength(0); expect(seen.reversedReceiptIds.size).toBe(0);
  await approval.getByRole('textbox', { name: 'Justificativa do retorno da NF 00015', exact: true }).fill('Segunda parcela conferida.');
  page.once('dialog', dialog => dialog.accept()); await approval.getByRole('button', { name: 'Aprovar retorno da NF 00015', exact: true }).click();
  await expect(finish(page)).toBeEnabled(); expect(seen.approvals.size).toBe(2);
  expect(seen.returnApplications).toHaveLength(0); expect(seen.reversedReceiptIds.size).toBe(0);
});

for (const uncertain of ['after-commit', 'proof'] as const) test(`aprovação com resultado incerto (${uncertain}) congela dados e repete o mesmo protocolo antes de liberar a importação`, async ({ page }) => {
  const seen = await setup(page, { manager: true, returnLines: [{ line: 1, kind: 'VALIDATED' }], approvalUncertain: uncertain }); await analyze(page);
  const approval = approvalRegion(page);
  await approval.getByRole('textbox', { name: 'Justificativa do retorno da NF 00014', exact: true }).fill('Correção individual conferida.');
  page.once('dialog', dialog => dialog.accept()); await approval.getByRole('button', { name: 'Aprovar retorno da NF 00014', exact: true }).click();
  await expect(approval.getByRole('button', { name: 'Conferir aprovação pendente', exact: true })).toBeVisible();
  await expect(approval.getByRole('textbox')).toBeDisabled(); await expect(finish(page)).toBeDisabled();
  await expect(page.getByLabel('Relatório de abertos e vencidos de Contas a Receber', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Analisar arquivo', exact: true })).toBeDisabled();
  await expect(page.getByRole('tablist', { name: 'Bases para atualização', exact: true }).getByRole('tab', { name: 'Contatos e descrições', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeDisabled();
  expect(seen.returnApplications).toHaveLength(0); expect(seen.reversedReceiptIds.size).toBe(0);
  await approval.getByRole('button', { name: 'Conferir aprovação pendente', exact: true }).click();
  await expect(finish(page)).toBeEnabled();
  expect(seen.approvalCalls).toHaveLength(2); expect(seen.approvalCalls[1]).toEqual(seen.approvalCalls[0]);
  expect(seen.approvals.size).toBe(1); expect(seen.returnApplications).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeEnabled();
});

test('metadados de retorno inválidos bloqueiam análise e não oferecem aprovação nem importação', async ({ page }) => {
  const seen = await setup(page, { manager: true, returnLines: [{ line: 1, kind: 'RETIRED' }], invalidReturnPreview: true }); await analyze(page);
  await expect(page.getByRole('alert')).toContainText('resposta inválida');
  await expect(page.getByRole('alert')).toContainText('Nenhuma baixa foi feita por esta análise');
  await expect(approvalRegion(page)).toHaveCount(0); await expect(finish(page)).toHaveCount(0);
  expect(seen.approvalCalls).toHaveLength(0); expect(seen.commits).toHaveLength(0);
});

test('mudança no valor recebido após a prévia recusa a aprovação mesmo com o mesmo título e recebimento', async ({ page }) => {
  const seen = await setup(page, { manager: true, returnLines: [{ line: 1, kind: 'VALIDATED' }] }); await analyze(page);
  const approval = approvalRegion(page);
  await expect(approval).toBeVisible();
  const original = [...seen.receipts.values()][0];
  seen.receipts.set(original.title_id, { ...original, amount_cents: original.amount_cents - 200 });
  await approval.getByRole('textbox', { name: 'Justificativa do retorno da NF 00014', exact: true }).fill('Correção conferida na prévia anterior.');
  page.once('dialog', dialog => dialog.accept()); await approval.getByRole('button', { name: 'Aprovar retorno da NF 00014', exact: true }).click();
  await expect(approval.getByRole('alert')).toContainText('O título, o recebimento ou a aprovação mudou.');
  await expect(finish(page)).toBeDisabled(); expect(seen.approvals.size).toBe(0);
  expect(seen.returnApplications).toHaveLength(0); expect(seen.reversedReceiptIds.size).toBe(0); expect(seen.commits).toHaveLength(0);
  expect(seen.approvalCalls[0].p_expected_receipt_fingerprint).toMatch(/^[a-f0-9]{64}$/);
});
