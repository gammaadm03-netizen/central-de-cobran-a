import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { setupReceivableImport as setup, analyzeReceivableImport as analyze, referenceDate } from './helpers/receivable-import';

const pendingButton = (page: Page) => page.getByRole('button', { name: 'Conferir confirmação pendente', exact: true });
const resumeButton = (page: Page) => page.getByRole('button', { name: 'Retomar o mesmo envio', exact: true });
const sourceInput = (page: Page) => page.getByLabel('Relatório de abertos e vencidos de Contas a Receber', { exact: true });
async function confirm(page: Page) {
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Concluir importação de abertos e vencidos', exact: true }).click();
  await expect(pendingButton(page)).toBeVisible();
}

test('a confirmação pendente consulta o protocolo e SHA originais sem analisar ou gravar outra vez', async ({ page }) => {
  const seen = await setup(page, { uncertainCommit: true, retireMissing: true }); await analyze(page); await confirm(page);
  const original = structuredClone(seen.commits[0]), previews = seen.previews.length;
  page.on('dialog', () => { throw new Error('A consulta não deve pedir uma nova confirmação financeira.'); });
  await pendingButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Importação concluída:' })).toContainText('2 ausentes retirados da carteira ativa');
  expect(seen.commits).toEqual([original]); expect(seen.previews).toHaveLength(previews);
  expect(seen.statuses).toEqual([{ action: 'status', mode: 'open', request_id: original.request_id, file_sha256: createHash('sha256').update(Buffer.from(original.file_base64, 'base64')).digest('hex'), full_report: true, reference_date: referenceDate, row_count: 1 }]);
  expect(seen.imports.size).toBe(1); expect(seen.retirementApplications).toHaveLength(2); expect(seen.financialWrites).toEqual([]);
});

test('resultado ainda não confirmado preserva o envio e só retoma a gravação por ação explícita com o mesmo protocolo', async ({ page }) => {
  const seen = await setup(page, { unconfirmedFirstCommit: true }); await analyze(page); await confirm(page);
  const original = structuredClone(seen.commits[0]), previews = seen.previews.length;
  await expect(resumeButton(page)).toHaveCount(0); await pendingButton(page).click(); await expect(resumeButton(page)).toBeVisible();
  expect(seen.commits).toEqual([original]); expect(seen.imports.size).toBe(0); expect(seen.statuses).toHaveLength(1);
  await expect(sourceInput(page)).toBeDisabled(); await expect(page.getByRole('button', { name: 'Analisar arquivo', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Abrangência do relatório', { exact: true })).toBeDisabled(); await expect(page.getByLabel('Data da posição do relatório', { exact: true })).toBeDisabled();
  await pendingButton(page).click(); expect(seen.commits).toEqual([original]); expect(seen.statuses).toHaveLength(2); await expect(resumeButton(page)).toBeVisible();
  page.on('dialog', () => { throw new Error('Retomar deve reutilizar a confirmação e o protocolo originais.'); });
  await resumeButton(page).click(); await expect(page.getByRole('status').filter({ hasText: 'Importação concluída:' })).toBeVisible();
  expect(seen.commits).toEqual([original, original]); expect(seen.previews).toHaveLength(previews); expect(seen.imports.size).toBe(1); expect(seen.financialWrites).toEqual([]);
});

test('novo timeout na consulta mantém o arquivo e nunca reenvia o commit automaticamente', async ({ page }) => {
  const seen = await setup(page, { uncertainCommit: true, statusFailure: true }); await analyze(page); await confirm(page);
  const original = structuredClone(seen.commits[0]); await pendingButton(page).click(); await expect(page.getByRole('alert')).toBeVisible();
  await expect(pendingButton(page)).toBeEnabled(); await expect(sourceInput(page)).toBeDisabled(); await expect(resumeButton(page)).toHaveCount(0);
  await pendingButton(page).click(); expect(seen.statuses).toHaveLength(2); expect(seen.commits).toEqual([original]); expect(seen.imports.size).toBe(1); expect(seen.financialWrites).toEqual([]);
});

test('consulta sem atualização062 orienta a ativação e não troca a leitura por uma gravação', async ({ page }) => {
  const seen = await setup(page, { uncertainCommit: true, statusActivationMissing: true }); await analyze(page); await confirm(page);
  await pendingButton(page).click(); await expect(page.getByRole('alert')).toContainText(/062/);
  await expect(sourceInput(page)).toBeDisabled(); await expect(pendingButton(page)).toBeEnabled(); await expect(resumeButton(page)).toHaveCount(0);
  expect(seen.statuses).toHaveLength(1); expect(seen.commits).toHaveLength(1); expect(seen.financialWrites).toEqual([]);
});

for (const tamperStatus of ['protocol', 'hash', 'count', 'date', 'full', 'result', 'empty-completed', 'unconfirmed-result'] as const) {
  test(`prova de consulta incompatível (${tamperStatus}) mantém a confirmação pendente sem nova gravação`, async ({ page }) => {
    const seen = await setup(page, { uncertainCommit: true, tamperStatus }); await analyze(page); await confirm(page);
    const original = structuredClone(seen.commits[0]); await pendingButton(page).click();
    await expect(page.getByRole('alert')).toBeVisible(); await expect(pendingButton(page)).toBeEnabled(); await expect(sourceInput(page)).toBeDisabled();
    await expect(resumeButton(page)).toHaveCount(0); await expect(page.getByRole('status').filter({ hasText: 'Importação concluída:' })).toHaveCount(0);
    expect(seen.statuses).toHaveLength(1); expect(seen.commits).toEqual([original]); expect(seen.financialWrites).toEqual([]);
  });
}
