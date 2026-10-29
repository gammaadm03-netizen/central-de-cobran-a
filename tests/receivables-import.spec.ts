import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import { setupReceivableImport as setup, analyzeReceivableImport as analyze, openCsv as csv, candidateId, referenceDate, retirementItems } from './helpers/receivable-import';

test('relatório completo é o padrão e exige declaração, data e confirmação sem presumir recebimento', async ({ page }) => {
  const seen = await setup(page);
  await expect(page.getByLabel('Abrangência do relatório', { exact: true })).toHaveValue('full');
  await expect(page.getByLabel('Data da posição do relatório', { exact: true })).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await page.getByLabel('Data da posição do relatório', { exact: true }).fill(referenceDate);
  await page.getByLabel('Relatório de abertos e vencidos de Contas a Receber', { exact: true }).setInputFiles({ name: 'cr.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByRole('button', { name: 'Analisar arquivo', exact: true })).toBeDisabled();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber' })).toBeVisible();
  await expect(page.getByText('Nenhum recebimento ou comissão será calculado por ausência.', { exact: true })).toBeVisible();
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Posição do relatório: 19/10/2026'); expect(dialog.message()).toContain('0 títulos ausentes sairão da carteira ativa'); expect(dialog.message()).toContain('Nenhum recebimento será confirmado por ausência'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Importação concluída:' })).toContainText('Nenhum recebimento foi presumido');
  expect(seen.commits).toHaveLength(1);
  const { request_id, ...payload } = seen.commits[0];
  expect(request_id).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i);
  expect(payload).toEqual({ action: 'commit', mode: 'open', file_name: 'cr.csv', file_base64: Buffer.from(csv).toString('base64'), complete: true, title_mappings: {}, collector_mappings: {}, previous_import_id: null, previous_financial_revision: '17', full_report: true, reference_date: referenceDate });
  expect(seen.financialWrites).toEqual([]); await expect(page.getByRole('cell', { name: 'cr.csv', exact: true })).toBeVisible();
});

test('relatório completo mostra os ausentes trabalhados e não trabalhados antes de retirar a carteira sem criar caixa', async ({ page }) => {
  const seen = await setup(page, { retireMissing: true, reappeared: 1 }); await analyze(page);
  await expect(page.getByText('0 títulos com alterações · 1 retornando à carteira.', { exact: true })).toBeVisible();
  await expect(page.getByText('2 títulos ausentes sairão da carteira ativa: 1 ficarão pendentes em Comissões e 1 permanecerão somente no histórico.', { exact: true })).toBeVisible();
  await page.getByText('Conferir 2 títulos ausentes do relatório completo', { exact: true }).click();
  const missing = page.getByRole('table', { name: 'Títulos que sairão da carteira ativa', exact: true });
  await expect(missing.getByRole('row')).toHaveCount(3);
  await expect(missing.getByRole('cell', { name: 'Pendente em Comissões — aguardando quitados', exact: true })).toBeVisible();
  await expect(missing.getByRole('cell', { name: 'Histórico, sem recebimento confirmado', exact: true })).toBeVisible();
  await expect(page.getByText('Nenhum recebimento ou comissão será calculado por ausência.', { exact: true })).toBeVisible();
  expect(seen.commits).toHaveLength(0); expect(seen.retirementApplications).toHaveLength(0); expect(seen.receipts.size).toBe(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('2 títulos ausentes sairão da carteira ativa: 1 pendentes em Comissões e 1 sem cobrança'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Concluir importação de abertos e vencidos', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Importação concluída:' })).toContainText('2 ausentes retirados da carteira ativa; 1 pendentes em Comissões, aguardando o relatório de quitados');
  expect(seen.previews[0]).toMatchObject({ full_report: true, reference_date: referenceDate });
  expect(seen.commits[0]).toMatchObject({ full_report: true, reference_date: referenceDate });
  expect(seen.retirementApplications).toEqual(retirementItems); expect(seen.receipts.size).toBe(0); expect(seen.financialWrites).toEqual([]);
});

test('inclusão e atualização preserva todos os ausentes e envia a abrangência explicitamente', async ({ page }) => {
  const seen = await setup(page, { retireMissing: true });
  await page.getByLabel('Abrangência do relatório', { exact: true }).selectOption('incremental');
  await analyze(page);
  await expect(page.getByText('Somente inclusão e atualização: títulos ausentes serão preservados.', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Conferir \d+ títulos ausentes do relatório completo$/)).toHaveCount(0);
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Inclusão/atualização: títulos ausentes continuarão como estão'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Concluir importação de abertos e vencidos', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Importação concluída:' })).toContainText('0 ausentes retirados da carteira ativa; 0 pendentes em Comissões');
  expect(seen.previews[0]).toMatchObject({ full_report: false, reference_date: referenceDate });
  expect(seen.commits[0]).toMatchObject({ full_report: false, reference_date: referenceDate });
  expect(seen.retirementApplications).toEqual([]); expect(seen.receipts.size).toBe(0); expect(seen.financialWrites).toEqual([]);
});

test('mudar data ou abrangência invalida análise e declaração anteriores', async ({ page }) => {
  const seen = await setup(page); await analyze(page);
  await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber', exact: true })).toBeVisible();
  await page.getByLabel('Abrangência do relatório', { exact: true }).selectOption('incremental');
  await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber', exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber', exact: true })).toBeVisible();
  await page.getByLabel('Data da posição do relatório', { exact: true }).fill('2026-10-18');
  await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber', exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  expect(seen.previews).toHaveLength(2); expect(seen.commits).toHaveLength(0);
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
test('prévia antiga com quitado presente exige ativação da aprovação sem reabrir automaticamente', async ({ page }) => {
  const seen = await setup(page, { validatedPresent: true }); await analyze(page);
  await expect(page.getByText('1 título(s) já quitado(s) reaparecem no relatório. A importação não reabre esses títulos.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Ative o SQL 057');
  await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' })).toBeDisabled(); expect(seen.commits).toHaveLength(0);
});
test('conciliação destaca quitado fora das dez primeiras linhas e separa nominal excluído do valor ainda não quitado no arquivo', async ({ page }) => {
  const seen = await setup(page, { validatedLines: [47] });
  const [header, first] = csv.split('\r\n');
  const content = [header, ...Array.from({ length: 50 }, (_, index) => {
    const cells = first.split(';'); cells[0] = `NF-RECON-${index + 1}`; cells[4] = index === 46 ? '321,09' : '10,00'; return cells.join(';');
  })].join('\r\n');
  await analyze(page, content);
  const reconciliation = page.getByRole('region', { name: 'Quitados presentes no relatório de abertos', exact: true });
  await expect(reconciliation.getByText('Valor original do arquivo já quitado na Central: R$ 321,09', { exact: true })).toBeVisible();
  await expect(reconciliation.getByText('Valor do arquivo ainda não quitado na Central: R$ 490,00', { exact: true })).toBeVisible();
  const known = reconciliation.getByRole('table', { name: 'Títulos já quitados identificados nesta análise', exact: true });
  await expect(known.getByRole('cell', { name: 'Cliente sintético · NF-RECON-47', exact: true })).toBeVisible();
  await expect(known.getByRole('cell', { name: '48', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Conferência das primeiras 10 linhas oficiais', exact: true })).not.toContainText('NF-RECON-47');
  await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('Ative o SQL 057');
  expect(seen.commits).toHaveLength(0);
  expect(seen.receipts.size).toBe(0); expect(seen.financialWrites).toEqual([]);
});
for (const proof of ['missing', 'other'] as const) test(`conciliação sem vínculo selecionado comprovado (${proof}) informa a contagem e não inventa valor excluído`, async ({ page }) => {
  const seen = await setup(page, { validatedPresent: true, validatedCandidateProof: proof }); await analyze(page);
  const reconciliation = page.getByRole('region', { name: 'Quitados presentes no relatório de abertos', exact: true });
  await expect(reconciliation).toContainText('1 título(s) já quitado(s) reaparecem no relatório.');
  await expect(reconciliation).toContainText('O valor total excluído não foi calculado.');
  await expect(reconciliation.getByText(/^Valor original do arquivo já quitado na Central:/)).toHaveCount(0);
  await expect(reconciliation.getByText(/^Valor do arquivo ainda não quitado na Central:/)).toHaveCount(0);
  await expect(reconciliation.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos', exact: true })).toBeDisabled();
  expect(seen.commits).toHaveLength(0); expect(seen.financialWrites).toEqual([]);
});
test('vencimento ambíguo exige vínculo explícito e nova análise antes de atualizar a parcela existente', async ({ page }) => {
  const seen = await setup(page, { ambiguous: 1 }); await analyze(page);
  await expect(page.getByRole('heading', { name: 'Conferir parcelas do mesmo documento' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' })).toBeDisabled();
  await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Escolha o vínculo da parcela antes de importar.', exact: true }) }).getByRole('cell').first()).toHaveText('2');
  await page.getByLabel('Vínculo da linha 2', { exact: true }).selectOption(candidateId);
  await expect(page.getByText(/^Vínculos alterados\./)).toBeVisible(); await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' })).toBeDisabled();
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

test('prévia anterior à atualização047 orienta ativação e não permite confirmar relatório completo', async ({ page }) => {
  const seen = await setup(page, { missingOpenReportMetadata: true }); await analyze(page);
  await expect(page.getByRole('alert')).toContainText('Ative a atualização 047 no banco e publique a função receivables-import');
  await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos', exact: true })).toHaveCount(0);
  expect(seen.previews).toHaveLength(1); expect(seen.commits).toHaveLength(0); expect(seen.financialWrites).toEqual([]);
});

test('contagem inconsistente dos ausentes bloqueia a confirmação sem presumir baixa financeira', async ({ page }) => {
  const seen = await setup(page, { retireMissing: true, invalidOpenReportCounts: true }); await analyze(page);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos', exact: true })).toHaveCount(0);
  expect(seen.commits).toHaveLength(0); expect(seen.retirementApplications).toEqual([]); expect(seen.receipts.size).toBe(0);
});

test('resposta de confirmação com protocolo divergente permanece pendente e confere o mesmo envio', async ({ page }) => {
  const seen = await setup(page, { tamperFirstCommitEcho: true }); await analyze(page);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Concluir importação de abertos e vencidos', exact: true }).click();
  await expect(page.getByText('A confirmação está pendente.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Analisar arquivo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Conferir confirmação pendente', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Importação concluída:' })).toBeVisible();
  expect(seen.commits).toHaveLength(2); expect(seen.commits[1]).toEqual(seen.commits[0]); expect(seen.previews).toHaveLength(1); expect(seen.imports.size).toBe(1); expect(seen.financialWrites).toEqual([]);
});
