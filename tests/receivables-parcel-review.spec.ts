import { expect, test, type Page } from '@playwright/test';
import {
  setupReceivableImport as setup, analyzeReceivableImport as analyze,
  candidateId, openCsv, receivedCsv,
} from './helpers/receivable-import';

// Data ordinals differ from physical Excel rows by the header. These are the
// positions reported in the screenshot, with entirely synthetic source rows.
const ambiguousLines = [10, 11, 15, 16, 17, 32];
const choices = Object.fromEntries(ambiguousLines.map(line => [String(line), 'NEW']));
function report(mode: 'open' | 'received') {
  const [header, row] = (mode === 'open' ? openCsv : receivedCsv).split('\r\n');
  return [header, ...Array.from({ length: 35 }, (_, index) => row.replace('00014;', `${String(index + 1).padStart(5, '0')};`))].join('\r\n');
}
async function start(page: Page, mode: 'open' | 'received', options = {}) {
  const seen = await setup(page, { ambiguousLines, ...options });
  if (mode === 'received') await page.getByRole('button', { name: 'Títulos quitados', exact: true }).click();
  await analyze(page, report(mode), mode);
  await expect(page.getByRole('heading', { name: 'Conferir parcelas do mesmo documento' })).toBeVisible();
  return seen;
}
const confirmation = (page: Page, mode: 'open' | 'received') => page.getByRole('button', {
  name: mode === 'open' ? 'Concluir importação de abertos e vencidos' : 'Confirmar importação de títulos quitados', exact: true,
});

for (const mode of ['open', 'received'] as const) {
  test(`${mode}: valida seis novas parcelas junto às escolhas, conserva os ordinais e exige confirmação separada`, async ({ page }) => {
    const seen = await start(page, mode);
    await expect(confirmation(page, mode)).toBeDisabled();
    for (const line of ambiguousLines) await expect(page.getByLabel(`Vínculo da linha ${line + 1}`, { exact: true })).toBeVisible();
    const original = seen.previews[0].file_base64;
    await page.getByRole('button', { name: 'Marcar 6 linha(s) como novas parcelas', exact: true }).click();
    for (const line of ambiguousLines) await expect(page.getByLabel(`Vínculo da linha ${line + 1}`, { exact: true })).toHaveValue('NEW');
    await expect(page.getByRole('alert').filter({ hasText: 'Importação bloqueada.' })).toHaveCount(0);
    await expect(page.getByText(/análise anterior/i).first()).toBeVisible();
    await expect(confirmation(page, mode)).toBeDisabled();
    expect(seen.previews).toHaveLength(1);
    expect(seen.commits).toHaveLength(0);

    await page.getByRole('button', { name: 'Validar escolhas de parcelas', exact: true }).click();
    await expect(confirmation(page, mode)).toBeEnabled();
    expect(seen.previews).toHaveLength(2);
    expect(seen.previews[1].title_mappings).toEqual(choices);
    expect(seen.previews[1].file_base64).toBe(original);
    await expect(page.getByRole('region', { name: 'Problemas encontrados na importação', exact: true })).toHaveCount(0);
    expect(seen.commits).toHaveLength(0);

    page.once('dialog', dialog => dialog.accept());
    await confirmation(page, mode).click();
    await expect(page.getByRole('status').filter({ hasText: 'Importação concluída:' })).toBeVisible();
    expect(seen.commits).toHaveLength(1);
    expect(seen.commits[0].title_mappings).toEqual(choices);
    expect(seen.commits[0].file_base64).toBe(original);
    expect(seen.financialWrites).toEqual([]);
  });

  test(`${mode}: resposta que ignora Nova parcela informa o problema e preserva escolhas sem gravar`, async ({ page }) => {
    const seen = await start(page, mode, { ignoreTitleMappings: true });
    await page.getByRole('button', { name: 'Marcar 6 linha(s) como novas parcelas', exact: true }).click();
    await page.getByRole('button', { name: 'Validar escolhas de parcelas', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'A função de importação não aplicou os vínculos selecionados.' })).toBeVisible();
    await expect(confirmation(page, mode)).toBeDisabled();
    for (const line of ambiguousLines) await expect(page.getByLabel(`Vínculo da linha ${line + 1}`, { exact: true })).toHaveValue('NEW');
    expect(seen.previews[1].title_mappings).toEqual(choices);
    expect(seen.commits).toHaveLength(0);
    expect(seen.financialWrites).toEqual([]);
  });
}

test('validar apenas uma escolha conserva as demais pendências, sem diagnosticar função incompatível', async ({ page }) => {
  const seen = await start(page, 'received');
  await page.getByLabel('Vínculo da linha 11', { exact: true }).selectOption(candidateId);
  await page.getByRole('button', { name: 'Validar escolhas de parcelas', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Problemas encontrados na importação', exact: true }).getByRole('row')).toHaveCount(6);
  await expect(page.getByRole('alert').filter({ hasText: 'A função de importação não aplicou' })).toHaveCount(0);
  await expect(page.getByLabel('Vínculo da linha 11', { exact: true })).toHaveValue(candidateId);
  await expect(confirmation(page, 'received')).toBeDisabled();
  expect(seen.previews[1].title_mappings).toEqual({ '10': candidateId });
  expect(seen.commits).toHaveLength(0);
});

test('conflito financeiro após escolher parcela conserva a divergência original', async ({ page }) => {
  const seen = await start(page, 'received', { mappingConflict: true });
  await page.getByLabel('Vínculo da linha 11', { exact: true }).selectOption('NEW');
  await page.getByRole('button', { name: 'Validar escolhas de parcelas', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Recebimento manual divergente. Nenhum registro será substituído.', exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'A função de importação não aplicou' })).toHaveCount(0);
  await expect(confirmation(page, 'received')).toBeDisabled();
  expect(seen.commits).toHaveLength(0);
});

test('resposta ambígua sem erros e com can_commit inconsistente continua bloqueada após escolha explícita', async ({ page }) => {
  const seen = await start(page, 'received', { ignoreTitleMappings: true, invalidMappedPreview: true });
  await page.getByRole('button', { name: 'Marcar 6 linha(s) como novas parcelas', exact: true }).click();
  await page.getByRole('button', { name: 'Validar escolhas de parcelas', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'A função de importação não aplicou os vínculos selecionados.' })).toBeVisible();
  await expect(confirmation(page, 'received')).toBeDisabled();
  expect(seen.previews[1].title_mappings).toEqual(choices);
  expect(seen.commits).toHaveLength(0);
  expect(seen.financialWrites).toEqual([]);
});

test('botão próximo das parcelas exige a declaração e é limpo ao trocar o arquivo', async ({ page }) => {
  const seen = await start(page, 'received');
  await page.getByLabel('Vínculo da linha 11', { exact: true }).selectOption('NEW');
  await page.getByRole('checkbox').uncheck();
  await expect(page.getByRole('button', { name: 'Validar escolhas de parcelas', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click();
  await expect(page.getByLabel('Vínculo da linha 11', { exact: true })).toHaveValue('NEW');
  await page.getByLabel('Relatório de títulos quitados de Contas a Receber', { exact: true }).setInputFiles({
    name: 'outra-copia.csv', mimeType: 'text/csv', buffer: Buffer.from(report('received')),
  });
  await expect(page.getByRole('button', { name: 'Validar escolhas de parcelas', exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  expect(seen.commits).toHaveLength(0);
});

test('503 ao validar escolhas mantém as seis parcelas visíveis e permite repetir somente a análise', async ({ page }) => {
  const seen = await start(page, 'received');
  await page.getByRole('button', { name: 'Marcar 6 linha(s) como novas parcelas', exact: true }).click();
  let failed = false;
  await page.route('**/functions/v1/receivables-import', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().action !== 'preview' || failed) return route.fallback();
    failed = true;
    return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': 'http://127.0.0.1:4173' }, json: { error: 'private SQL details must never appear' } });
  });
  await page.getByRole('button', { name: 'Validar escolhas de parcelas', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'HTTP503' })).toBeVisible();
  for (const line of ambiguousLines) await expect(page.getByLabel(`Vínculo da linha ${line + 1}`, { exact: true })).toHaveValue('NEW');
  await expect(confirmation(page, 'received')).toBeDisabled();
  await expect(page.getByText('private SQL details', { exact: false })).toHaveCount(0);
  expect(seen.commits).toHaveLength(0);
  await page.getByRole('button', { name: 'Validar escolhas de parcelas', exact: true }).click();
  await expect(confirmation(page, 'received')).toBeEnabled();
  expect(seen.previews.at(-1).title_mappings).toEqual(choices);
  expect(seen.commits).toHaveLength(0);
});

test('resposta que não é JSON informa a falha do serviço sem expor o conteúdo nem permitir confirmação', async ({ page }) => {
  const seen = await start(page, 'received');
  await page.getByRole('button', { name: 'Marcar 6 linha(s) como novas parcelas', exact: true }).click();
  await page.route('**/functions/v1/receivables-import', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ status: 502, headers: { 'access-control-allow-origin': 'http://127.0.0.1:4173' }, contentType: 'text/html', body: '<html>private SQL diagnostic</html>' });
  });
  await page.getByRole('button', { name: 'Validar escolhas de parcelas', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'HTTP502' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'CR_INVALID_RESPONSE' })).toBeVisible();
  await expect(page.getByText('private SQL diagnostic', { exact: false })).toHaveCount(0);
  await expect(confirmation(page, 'received')).toBeDisabled();
  expect(seen.commits).toHaveLength(0);
});

test('503 na confirmação conserva o envio como incerto e não afirma que nada foi alterado', async ({ page }) => {
  const seen = await start(page, 'received');
  await page.getByRole('button', { name: 'Marcar 6 linha(s) como novas parcelas', exact: true }).click();
  await page.getByRole('button', { name: 'Validar escolhas de parcelas', exact: true }).click();
  await expect(confirmation(page, 'received')).toBeEnabled();
  await page.route('**/functions/v1/receivables-import', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().action !== 'commit') return route.fallback();
    return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': 'http://127.0.0.1:4173' }, json: { error: 'private commit information' } });
  });
  page.once('dialog', dialog => dialog.accept()); await confirmation(page, 'received').click();
  const alert = page.getByRole('alert').filter({ hasText: 'HTTP503' });
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText('Nenhum dado foi alterado');
  await expect(page.getByRole('status').filter({ hasText: 'A confirmação está pendente.' })).toBeVisible();
  await expect(page.getByLabel('Relatório de títulos quitados de Contas a Receber', { exact: true })).toBeDisabled();
  await expect(confirmation(page, 'received')).toBeDisabled();
  await expect(page.getByText('private commit information', { exact: false })).toHaveCount(0);
  expect(seen.commits).toHaveLength(0);
});
