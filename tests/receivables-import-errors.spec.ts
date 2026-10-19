import { test, expect } from '@playwright/test';
import { setupReceivableImport as setup, analyzeReceivableImport as analyze, openCsv, receivedCsv } from './helpers/receivable-import';

const problemRegion = { name: 'Problemas encontrados na importação', exact: true };

for (const mode of ['open', 'received'] as const) {
  const content = mode === 'open' ? openCsv : receivedCsv;
  const fileLabel = mode === 'open' ? 'Relatório de abertos e vencidos de Contas a Receber' : 'Relatório de títulos quitados de Contas a Receber';

  test(`${mode}: erro do arquivo mostra linha, coluna e correção no aviso, sem enviar títulos`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 650 });
    const seen = await setup(page);
    if (mode === 'received') await page.getByRole('button', { name: 'Títulos quitados', exact: true }).click();
    await analyze(page, content.replace('16/10/2026', '31/02/2026'), mode);

    const region = page.getByRole('region', problemRegion), alert = region.getByRole('alert');
    await expect(alert).toContainText('Importação bloqueada. Nenhum dado foi alterado por esta análise.');
    await expect(alert).toContainText('1 problema(s) encontrado(s) nesta análise.');
    await expect(alert).toContainText('Linha 2 · Vencimento: Data inexistente.');
    await expect(alert).toContainText('Como corrigir: Corrija a célula no arquivo original e selecione uma nova cópia.');
    await expect(region).toBeFocused();
    await expect(alert).toBeInViewport({ ratio: 0.99 });
    await expect(alert.locator('p').nth(1)).toBeInViewport({ ratio: 1 });
    await expect(region.getByRole('cell', { name: 'Data inexistente.', exact: true })).toBeVisible();
    await expect(region.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Data inexistente.', exact: true }) }).getByRole('cell').first()).toHaveText('2');
    await expect(page.getByLabel(fileLabel, { exact: true })).toHaveValue(/cr\.csv$/);
    await expect(page.getByRole('checkbox')).toBeChecked();
    await expect(page.getByRole('button', { name: /Concluir importação de abertos|Confirmar importação de títulos/ })).toHaveCount(0);
    expect(seen.previews).toHaveLength(0);
    expect(seen.commits).toHaveLength(0);
    expect(seen.financialWrites).toEqual([]);

    // Editing the declaration is an ordinary form action, not a new analysis.
    await page.getByRole('checkbox').uncheck();
    await expect(page.getByRole('checkbox')).toBeFocused();
  });

  test(`${mode}: diagnóstico estruturado do servidor aparece no mesmo aviso sem expor detalhes técnicos`, async ({ page }) => {
    const seen = await setup(page, { serverInvalid: true });
    if (mode === 'received') await page.getByRole('button', { name: 'Títulos quitados', exact: true }).click();
    await analyze(page, content, mode);

    const region = page.getByRole('region', problemRegion), alert = region.getByRole('alert');
    await expect(alert).toContainText('Linha 2 · CNPJ: CNPJ deve conter exatamente 14 dígitos. Não complete zeros automaticamente.');
    await expect(alert).toContainText('Como corrigir: Corrija a célula no arquivo original e selecione uma nova cópia.');
    await expect(region).toBeFocused();
    await expect(region.getByRole('row').filter({ has: page.getByRole('cell', { name: 'CNPJ deve conter exatamente 14 dígitos. Não complete zeros automaticamente.', exact: true }) }).getByRole('cell').first()).toHaveText('2');
    await expect(page.getByLabel(fileLabel, { exact: true })).toHaveValue(/cr\.csv$/);
    await expect(page.getByText('private stack trace')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Concluir importação de abertos|Confirmar importação de títulos/ })).toHaveCount(0);
    expect(seen.previews).toHaveLength(1);
    expect(seen.commits).toHaveLength(0);
    expect(seen.financialWrites).toEqual([]);
  });
}

test('erro do arquivo sem linha física é mostrado como Arquivo, sem inventar linha zero', async ({ page }) => {
  const seen = await setup(page);
  await page.getByLabel('Relatório de abertos e vencidos de Contas a Receber', { exact: true }).setInputFiles({ name: 'relatorio.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('synthetic legacy workbook') });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click();

  const region = page.getByRole('region', problemRegion), alert = region.getByRole('alert');
  await expect(alert).toContainText('Arquivo: O formato .xls antigo ainda não é aceito.');
  await expect(alert).not.toContainText('Linha 0');
  await expect(region.getByRole('row').filter({ has: page.getByRole('cell', { name: 'O formato .xls antigo ainda não é aceito. No Excel, salve uma cópia como .xlsx e selecione essa cópia.', exact: true }) }).getByRole('cell').first()).toHaveText('—');
  expect(seen.previews).toHaveLength(0);
  expect(seen.commits).toHaveLength(0);
});

test('diagnóstico de parcela fica antes das carteiras e mantém a escolha obrigatória', async ({ page }) => {
  const seen = await setup(page, { ambiguous: 1 });
  await analyze(page);
  const region = page.getByRole('region', problemRegion);
  await expect(region.getByRole('alert')).toContainText('Linha 2 · Documento / NF: Escolha o vínculo da parcela antes de importar.');
  await expect(region).toBeFocused();
  const order = await region.evaluate(node => {
    const collectors = document.getElementById('import-collectors-title');
    return !!collectors && !!(node.compareDocumentPosition(collectors) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
  await expect(page.getByRole('button', { name: 'Concluir importação de abertos e vencidos' })).toBeDisabled();
  await page.getByLabel('Vínculo da linha 2', { exact: true }).focus();
  await page.getByLabel('Vínculo da linha 2', { exact: true }).selectOption('NEW');
  await expect(page.getByLabel('Vínculo da linha 2', { exact: true })).toBeFocused();
  expect(seen.previews).toHaveLength(1);
  expect(seen.commits).toHaveLength(0);
});
