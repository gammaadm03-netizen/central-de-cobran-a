import { expect, test, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { setupReceivableImport as setup, analyzeReceivableImport as analyze, collectorA, collectorB, collectorNames, referenceDate, receivedCsv } from './helpers/receivable-import';

const clientA = 'Cliente inicial sintético A', clientB = 'Cliente inicial sintético B', clientC = 'Cliente seguinte sintético C';
const keyA = 'name:CLIENTE INICIAL SINTÉTICO A', keyB = 'name:CLIENTE INICIAL SINTÉTICO B', keyC = 'name:CLIENTE SEGUINTE SINTÉTICO C';
const owner = (page: Page, client: string) => page.getByRole('combobox', { name: `Cobradora de ${client}`, exact: true });
const analyzeButton = (page: Page) => page.getByRole('button', { name: 'Analisar arquivo', exact: true });
const commitButton = (page: Page) => page.getByRole('button', { name: 'Concluir importação de abertos e vencidos', exact: true });

async function workbook(names: string[] = [' RESPONSAVEL SINTETICA A ', collectorNames[collectorA], collectorNames[collectorB]]) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Base inicial sintética');
  sheet.addRow(['Histórico', 'Entidade 1 - Entidade: nome', 'Documento: número', 'Emissão: valor do lançamento', 'Emissão: data', 'Vencimento: data', 'Forma de quitação', 'Filial', 'COBRADORA']);
  const clients = [clientA, clientA, clientB], amounts = [100.01, 200.02, 300.03];
  for (let index = 0; index < names.length; index++) sheet.addRow(['Histórico sintético', clients[index], String(index + 1).padStart(5, '0'), amounts[index], new Date('2026-10-01T13:30:00Z'), new Date('2026-10-16T00:00:00Z'), 'Transferência sintética', index === 1 ? 'Filial B' : 'Filial A', names[index]]);
  sheet.getColumn(4).numFmt = '#,##0.00'; sheet.getColumn(5).numFmt = sheet.getColumn(6).numFmt = 'dd/mm/yyyy hh:mm';
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function uploadWorkbook(page: Page, bytes: Buffer) {
  await page.getByLabel('Relatório de abertos e vencidos de Contas a Receber', { exact: true }).setInputFiles({ name: 'carga-inicial-sintetica.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
  await page.getByLabel('Data da posição do relatório', { exact: true }).fill(referenceDate);
  await page.getByRole('checkbox', { name: /^Confirmo que este é o relatório completo/ }).check();
  await analyzeButton(page).click();
}
async function reanalyze(page: Page) {
  await analyzeButton(page).click(); await expect(analyzeButton(page)).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber', exact: true })).toBeVisible();
}
async function commit(page: Page) {
  page.once('dialog', dialog => dialog.accept()); await commitButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Importação concluída' })).toBeVisible();
}

const nextCsv = [
  'Documento: número;Entidade 1 - Entidade: nome;Filial;Vencimento: data;Emissão: valor do lançamento',
  `00001;${clientA};Filial A;16/10/2026;100,01`,
  `00002;${clientA};Filial B;16/10/2026;200,02`,
  `00003;${clientB};Filial A;16/10/2026;300,03`,
  `00004;${clientC};Filial A;19/10/2026;400,04`,
].join('\r\n');

test('primeira base XLSX usa COBRADORA e próxima base sem a coluna preserva carteiras e exige escolha somente do cliente novo', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all' }), bytes = await workbook();
  await uploadWorkbook(page, bytes);
  await expect(owner(page, clientA)).toHaveValue(collectorA); await expect(owner(page, clientB)).toHaveValue(collectorB);
  await expect(commitButton(page)).toBeEnabled();
  await expect(page.getByText('3 títulos · total original R$ 600,06 · 3 novos títulos.', { exact: true })).toBeVisible();
  expect(seen.previews[0].collector_mappings).toEqual({});
  expect(seen.previews.at(-1).collector_mappings).toEqual({ [keyA]: collectorA, [keyB]: collectorB });
  expect(seen.previews.every(body => body.file_base64 === bytes.toString('base64'))).toBe(true);
  await commit(page);
  expect(seen.commits[0].collector_mappings).toEqual({ [keyA]: collectorA, [keyB]: collectorB });
  expect(seen.commits[0].file_base64).toBe(bytes.toString('base64'));
  expect(seen.assignmentApplications).toEqual(expect.arrayContaining([{ customer_key: keyA, collector_id: collectorA, row_count: 2 }, { customer_key: keyB, collector_id: collectorB, row_count: 1 }]));
  await analyze(page, nextCsv);
  await expect(owner(page, clientA)).toHaveCount(0); await expect(owner(page, clientB)).toHaveCount(0);
  await expect(owner(page, clientC)).toHaveValue(''); await expect(commitButton(page)).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Usar cobradoras da planilha', exact: true })).toHaveCount(0);
  expect(seen.previews.at(-1).collector_mappings).toEqual({});
  await owner(page, clientC).selectOption(collectorB); await reanalyze(page); await expect(commitButton(page)).toBeEnabled(); await commit(page);
  expect(seen.commits[1].collector_mappings).toEqual({ [keyC]: collectorB });
  expect(seen.owners.get(keyA)).toBe(collectorA); expect(seen.owners.get(keyB)).toBe(collectorB); expect(seen.owners.get(keyC)).toBe(collectorB);
  expect(seen.assignmentApplications).toHaveLength(3); expect(seen.financialWrites).toEqual([]);
});

test('nome da planilha sem correspondência ativa não é adivinhado e pode ser resolvido pela seleção explícita na Central', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all' });
  await uploadWorkbook(page, await workbook(['Nome inexistente de responsável', 'Nome inexistente de responsável', collectorNames[collectorB]]));
  await expect(owner(page, clientA)).toHaveValue(''); await expect(owner(page, clientB)).toHaveValue(collectorB); await expect(commitButton(page)).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Problemas encontrados na importação' })).toContainText(/cobradora/i);
  expect(Object.hasOwn(seen.previews.at(-1).collector_mappings, keyA)).toBe(false); expect(seen.commits).toHaveLength(0);
  await owner(page, clientA).selectOption(collectorA); await reanalyze(page); await expect(commitButton(page)).toBeEnabled(); await commit(page);
  expect(seen.commits[0].collector_mappings).toEqual({ [keyA]: collectorA, [keyB]: collectorB });
});

test('cobradora diferente na planilha não redistribui cliente que já tem carteira oficial', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: [keyB], collectorOwners: { [keyA]: collectorB } });
  await uploadWorkbook(page, await workbook()); await expect(commitButton(page)).toBeEnabled();
  await expect(owner(page, clientA)).toHaveCount(0); await expect(owner(page, clientB)).toHaveValue(collectorB);
  await expect(page.getByRole('row').filter({ hasText: clientA }).filter({ hasText: 'Carteira preservada' })).toContainText(collectorNames[collectorB]);
  expect(seen.previews.at(-1).collector_mappings).toEqual({ [keyB]: collectorB }); await commit(page);
  expect(seen.owners.get(keyA)).toBe(collectorB); expect(seen.assignmentApplications).toEqual([{ customer_key: keyB, collector_id: collectorB, row_count: 1 }]);
});

test('duas responsáveis com o mesmo nome normalizado exigem escolha explícita em vez de usar o primeiro cadastro', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all', collectorAgents: [
    { id: collectorA, display_name: collectorNames[collectorA], enabled: true },
    { id: collectorB, display_name: 'RESPONSAVEL SINTETICA A', enabled: true },
  ] });
  await uploadWorkbook(page, await workbook([collectorNames[collectorA]]));
  await expect(owner(page, clientA)).toHaveValue(''); await expect(commitButton(page)).toBeDisabled(); expect(seen.commits).toHaveLength(0);
  expect(Object.hasOwn(seen.previews.at(-1).collector_mappings, keyA)).toBe(false);
  await owner(page, clientA).selectOption(collectorB); await reanalyze(page); await expect(commitButton(page)).toBeEnabled(); await commit(page);
  expect(seen.commits[0].collector_mappings).toEqual({ [keyA]: collectorB });
});

test('conflito de responsáveis em duas notas do mesmo cliente bloqueia a planilha antes de qualquer análise remota', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all' });
  await uploadWorkbook(page, await workbook([collectorNames[collectorA], collectorNames[collectorB], collectorNames[collectorB]]));
  const problems = page.getByRole('region', { name: 'Problemas encontrados na importação' });
  await expect(problems).toBeVisible(); await expect(problems).toContainText('mesmo cliente');
  await expect(problems.getByRole('cell', { name: '3', exact: true })).toBeVisible();
  await expect(commitButton(page)).toHaveCount(0); expect(seen.previews).toHaveLength(0); expect(seen.commits).toHaveLength(0);
});

test('limpar uma escolha preenchida pela planilha impede reaplicação silenciosa na reanálise', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all' }); await uploadWorkbook(page, await workbook());
  await expect(commitButton(page)).toBeEnabled(); await owner(page, clientA).selectOption('');
  await expect(commitButton(page)).toBeDisabled(); await reanalyze(page);
  await expect(owner(page, clientA)).toHaveValue(''); await expect(owner(page, clientB)).toHaveValue(collectorB);
  expect(seen.previews.at(-1).collector_mappings).toEqual({ [keyB]: collectorB }); await expect(commitButton(page)).toBeDisabled();
});

test('confirmação incerta da carga com COBRADORA congela a origem e repete os mesmos bytes e vínculos', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all', uncertainCommit: true }), bytes = await workbook(); await uploadWorkbook(page, bytes);
  await expect(commitButton(page)).toBeEnabled(); page.once('dialog', dialog => dialog.accept()); await commitButton(page).click();
  const retry = page.getByRole('button', { name: 'Conferir confirmação pendente', exact: true }); await expect(retry).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Usar cobradoras da planilha', exact: true })).toBeDisabled();
  await expect(owner(page, clientA)).toBeDisabled(); await expect(owner(page, clientB)).toBeDisabled();
  const previews = seen.previews.length; await retry.click();
  await expect(page.getByRole('status').filter({ hasText: 'Importação concluída' })).toBeVisible();
  expect(seen.commits).toHaveLength(2); expect(seen.commits[1]).toEqual(seen.commits[0]); expect(seen.previews).toHaveLength(previews);
  expect(seen.commits[0].file_base64).toBe(bytes.toString('base64')); expect(seen.commits[0].collector_mappings).toEqual({ [keyA]: collectorA, [keyB]: collectorB });
  expect(seen.imports.size).toBe(1); expect(seen.assignmentApplications).toHaveLength(2);
});

test('quitados com coluna COBRADORA continuam sem atribuir responsáveis nem enviar escolhas de carteira', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all' });
  await page.getByRole('button', { name: 'Títulos quitados', exact: true }).click();
  const lines = receivedCsv.split('\r\n'), paid = lines.map((line, index) => `${line};${index ? 'Responsável sem cadastro que não deve atribuir carteira' : 'COBRADORA'}`).join('\r\n');
  await analyze(page, paid, 'received');
  const confirm = page.getByRole('button', { name: 'Confirmar importação de títulos quitados', exact: true }); await expect(confirm).toBeEnabled();
  page.once('dialog', dialog => dialog.accept()); await confirm.click(); await expect(page.getByRole('status').filter({ hasText: 'Importação concluída' })).toBeVisible();
  expect(seen.previews.every(body => !Object.hasOwn(body, 'collector_mappings'))).toBe(true); expect(Object.hasOwn(seen.commits[0], 'collector_mappings')).toBe(false);
  expect(seen.assignmentApplications).toEqual([]);
});
