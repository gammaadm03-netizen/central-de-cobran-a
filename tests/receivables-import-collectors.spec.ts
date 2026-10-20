import { expect, test, type Page } from '@playwright/test';
import { setupReceivableImport as setup, analyzeReceivableImport as analyze, openCsv, receivedCsv, collectorA, collectorB, collectorNames } from './helpers/receivable-import';

const defaultKey = 'cnpj:12345678000190';
const first = 'Órgão novo A', second = 'Órgão novo B', existing = 'Órgão com carteira';
const firstKey = 'name:ÓRGÃO NOVO A', secondKey = 'name:ÓRGÃO NOVO B', existingKey = 'name:ÓRGÃO COM CARTEIRA';
const groupedCsv = [
  'Documento: número;Entidade 1 - Entidade: nome;Filial;Vencimento: data;Emissão: valor do lançamento',
  `00001;${first};Filial A;16/10/2026;100,01`,
  `00002;${first};Filial B;17/10/2026;200,02`,
  `00003;${second};Filial A;18/10/2026;300,03`,
  `00004;${existing};Filial B;19/10/2026;400,04`,
].join('\r\n');
const owner = (page: Page, client = 'Cliente sintético') => page.getByRole('combobox', { name: `Cobradora de ${client}`, exact: true });
const bulk = (page: Page) => page.getByRole('combobox', { name: /^Cobradora para clientes sem responsável/ });
const analyzeButton = (page: Page) => page.getByRole('button', { name: 'Analisar arquivo', exact: true });
const commitButton = (page: Page) => page.getByRole('button', { name: 'Concluir importação de abertos e vencidos', exact: true });
const pendingButton = (page: Page) => page.getByRole('button', { name: 'Conferir confirmação pendente', exact: true });
async function reanalyze(page: Page) {
  const response = page.waitForResponse(reply => reply.request().method() === 'POST' && new URL(reply.url()).pathname === '/functions/v1/receivables-import' && reply.request().postDataJSON()?.action === 'preview');
  await analyzeButton(page).click(); await response;
  // An existing preview remains visible while validating new choices.
  // Wait for the complete analysis, not merely its previous heading.
  await expect(analyzeButton(page)).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber', exact: true })).toBeVisible();
}
async function commit(page: Page) { page.once('dialog', dialog => dialog.accept()); await commitButton(page).click(); await expect(page.getByRole('status').filter({ hasText: 'Importação concluída' })).toBeVisible(); }

test('novo cliente exige responsável explícita, nova análise e mesma escolha no envio definitivo', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all' }); await analyze(page);
  await expect(owner(page)).toBeEnabled(); await expect(owner(page)).toHaveValue(''); await expect(commitButton(page)).toBeDisabled(); expect(seen.previews[0].collector_mappings).toEqual({}); expect(seen.commits).toHaveLength(0);
  await owner(page).selectOption(collectorA); await expect(commitButton(page)).toBeDisabled(); expect(seen.previews).toHaveLength(1);
  await reanalyze(page); await expect(owner(page)).toHaveValue(collectorA); await expect(commitButton(page)).toBeEnabled();
  expect(seen.previews.at(-1).collector_mappings).toEqual({ [defaultKey]: collectorA }); await commit(page);
  expect(seen.commits[0]).toMatchObject({ mode: 'open', collector_mappings: { [defaultKey]: collectorA }, title_mappings: {}, complete: true, previous_import_id: null, previous_financial_revision: '17' });
  expect(seen.owners.get(defaultKey)).toBe(collectorA); expect(seen.assignmentApplications).toEqual([{ customer_key: defaultKey, collector_id: collectorA, row_count: 1 }]); expect(seen.financialWrites).toEqual([]);
  const agents = seen.reads.filter(read => read.path === '/rest/v1/collection_agents'); expect(agents.length).toBeGreaterThan(0); const query = new URLSearchParams(agents[0].query); expect(query.get('select')).toBe('id,display_name,enabled'); expect(query.get('enabled')).toBe('eq.true'); expect(query.get('order')).toBe('display_name.asc');
});

test('lote preenche só clientes sem carteira e agrupa duas notas e filiais do mesmo órgão', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: [firstKey, secondKey], collectorOwners: { [existingKey]: collectorB } }); await analyze(page, groupedCsv);
  await expect(owner(page, first)).toHaveValue(''); await expect(owner(page, second)).toHaveValue(''); await expect(owner(page, existing)).toHaveCount(0);
  await bulk(page).selectOption(collectorA); await page.getByRole('button', { name: 'Aplicar às carteiras sem responsável', exact: true }).click();
  await expect(owner(page, first)).toHaveValue(collectorA); await expect(owner(page, second)).toHaveValue(collectorA); await expect(commitButton(page)).toBeDisabled(); await reanalyze(page); await expect(commitButton(page)).toBeEnabled(); await commit(page);
  expect(seen.commits[0].collector_mappings).toEqual({ [firstKey]: collectorA, [secondKey]: collectorA }); expect(seen.owners.get(existingKey)).toBe(collectorB);
  expect(seen.assignmentApplications).toEqual(expect.arrayContaining([{ customer_key: firstKey, collector_id: collectorA, row_count: 2 }, { customer_key: secondKey, collector_id: collectorA, row_count: 1 }])); expect(seen.assignmentApplications).toHaveLength(2); expect(seen.commits[0].file_base64).toBe(Buffer.from(groupedCsv).toString('base64'));
});

test('cliente já atribuído permanece em leitura e importação não redistribui a carteira existente', async ({ page }) => {
  const seen = await setup(page, { collectorOwners: { [defaultKey]: collectorB } }); await analyze(page); await expect(owner(page)).toHaveCount(0); await expect(commitButton(page)).toBeEnabled();
  await expect(page.getByRole('row').filter({ hasText: 'Cliente sintético' }).filter({ hasText: collectorNames[collectorB] })).toHaveCount(1); await commit(page);
  expect(seen.commits[0].collector_mappings).toEqual({}); expect(seen.owners.get(defaultKey)).toBe(collectorB); expect(seen.assignmentApplications).toHaveLength(0);
});

test('alterar uma responsável já analisada invalida confirmação e exige conferir novamente a nova escolha', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all' }); await analyze(page); await owner(page).selectOption(collectorA); await reanalyze(page); await expect(commitButton(page)).toBeEnabled();
  await owner(page).selectOption(''); await expect(owner(page)).toHaveValue(''); await expect(commitButton(page)).toBeDisabled(); expect(seen.previews.at(-1).collector_mappings).toEqual({ [defaultKey]: collectorA }); await reanalyze(page); await expect(owner(page)).toHaveValue(''); expect(seen.previews.at(-1).collector_mappings).toEqual({}); await expect(commitButton(page)).toBeDisabled(); await owner(page).selectOption(collectorB); await expect(commitButton(page)).toBeDisabled(); expect(seen.commits).toHaveLength(0);
  await reanalyze(page); await expect(owner(page)).toHaveValue(collectorB); await expect(commitButton(page)).toBeEnabled(); await commit(page); expect(seen.commits[0].collector_mappings).toEqual({ [defaultKey]: collectorB }); expect(seen.owners.get(defaultKey)).toBe(collectorB);
});

test('reimportar os mesmos bytes preserva responsável e não duplica lote nem atribuição', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all' }); await analyze(page); await owner(page).selectOption(collectorA); await reanalyze(page); await commit(page);
  await analyze(page, openCsv); await expect(owner(page)).toHaveCount(0); await expect(commitButton(page)).toBeEnabled(); await commit(page);
  expect(seen.commits).toHaveLength(2); expect(seen.commits[1].file_base64).toBe(seen.commits[0].file_base64); expect(seen.commits[1].collector_mappings).toEqual({}); expect(seen.imports.size).toBe(1); expect(seen.assignmentApplications).toHaveLength(1); expect(seen.owners.get(defaultKey)).toBe(collectorA); expect(seen.financialWrites).toEqual([]);
});

test('resposta incerta congela escolhas e repete o mesmo protocolo sem reanalisar nem atribuir duas vezes', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all', uncertainCommit: true }); await analyze(page); await owner(page).selectOption(collectorB); await reanalyze(page); page.once('dialog', dialog => dialog.accept()); await commitButton(page).click();
  await expect(page.getByText('A confirmação está pendente.', { exact: false })).toBeVisible(); await expect(owner(page)).toBeDisabled(); await expect(page.getByLabel('Relatório de abertos e vencidos de Contas a Receber', { exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Títulos quitados', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Abrangência do relatório', { exact: true })).toBeDisabled(); await expect(page.getByLabel('Data da posição do relatório', { exact: true })).toBeDisabled(); await expect(page.getByRole('checkbox')).toBeDisabled(); await expect(analyzeButton(page)).toBeDisabled(); await expect(commitButton(page)).toBeDisabled();
  const previewsBefore=seen.previews.length;
  await pendingButton(page).click(); await expect(page.getByRole('status').filter({ hasText: 'Importação concluída' })).toBeVisible();
  expect(seen.commits).toHaveLength(2); expect(seen.commits[1]).toEqual(seen.commits[0]); expect(seen.commits[0].request_id).toMatch(/^[a-f\d-]{36}$/i); expect(seen.previews).toHaveLength(previewsBefore); expect(seen.imports.size).toBe(1); expect(seen.assignmentApplications).toHaveLength(1); expect(seen.owners.get(defaultKey)).toBe(collectorB); expect(seen.financialWrites).toEqual([]);
});

test('sem responsáveis ativas orienta cadastro e mantém a confirmação bloqueada', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all', agentsEmpty: true }); await analyze(page); await expect(commitButton(page)).toBeDisabled(); await expect(page.getByText(/Nenhuma (cobradora|responsável) ativa|Cadastre.*responsável|ative.*responsável/i).first()).toBeVisible(); expect(seen.commits).toHaveLength(0); expect(seen.assignmentApplications).toHaveLength(0);
});

test('análise antiga sem contrato030 não permite confirmar atribuições por outra rota', async ({ page }) => {
  const seen = await setup(page, { missingCollectorMetadata: true }); await analyze(page); await expect(page.getByRole('alert')).toBeVisible(); await expect(commitButton(page)).toHaveCount(0); expect(seen.commits).toHaveLength(0); expect(seen.previews[0].collector_mappings).toEqual({});
});

test('mudar arquivo limpa escolhas anteriores e quitados nunca enviam collector_mappings', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all' }); await analyze(page); await owner(page).selectOption(collectorA); await analyze(page, openCsv.replace('Cliente sintético', 'Cliente totalmente diferente')); await expect(owner(page, 'Cliente totalmente diferente')).toHaveValue(''); expect(seen.previews.at(-1).collector_mappings).toEqual({});
  await page.getByRole('button', { name: 'Títulos quitados', exact: true }).click(); await analyze(page, receivedCsv, 'received'); await expect(owner(page)).toHaveCount(0); await expect(bulk(page)).toHaveCount(0);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Confirmar importação de títulos quitados', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: 'Importação concluída' })).toBeVisible(); expect(seen.previews.filter(body => body.mode === 'received').every(body => !Object.hasOwn(body, 'collector_mappings'))).toBe(true); expect(Object.hasOwn(seen.commits[0], 'collector_mappings')).toBe(false);
});

test('quitação externa durante confirmação incerta permanece intacta no replay do protocolo original', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all', paidAfterUncertainCommit: true, ambiguous: 1 }); await analyze(page); await page.getByLabel('Vínculo da linha 2', { exact: true }).selectOption('NEW'); await owner(page).selectOption(collectorA); await reanalyze(page); page.once('dialog', dialog => dialog.accept()); await commitButton(page).click();
  await expect(page.getByText('A confirmação está pendente.', { exact: false })).toBeVisible(); expect(seen.imports.size).toBe(1); expect(seen.assignmentApplications).toHaveLength(1); expect(seen.receipts.size).toBe(1); const receiptsBefore = [...seen.receipts.entries()].map(([key, value]) => [key, { ...value }]);
  await expect(page.getByLabel('Relatório de abertos e vencidos de Contas a Receber', { exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Títulos quitados', exact: true })).toBeDisabled(); await expect(page.getByRole('checkbox')).toBeDisabled(); await expect(page.getByLabel('Vínculo da linha 2', { exact: true })).toBeDisabled();
  await expect(analyzeButton(page)).toBeDisabled(); const previewsBefore=seen.previews.length;
  await pendingButton(page).click(); await expect(page.getByRole('status').filter({ hasText: 'Importação concluída' })).toBeVisible();
  expect(seen.commits).toHaveLength(2); expect(seen.commits[1]).toEqual(seen.commits[0]); expect(seen.commits[1].collector_mappings).toEqual({ [defaultKey]: collectorA }); expect(seen.commits[1].title_mappings).toEqual({ '1': 'NEW' }); expect(seen.previews).toHaveLength(previewsBefore); expect(seen.rejectedCollectorPreviews).toBe(0); expect(seen.imports.size).toBe(1); expect(seen.assignmentApplications).toHaveLength(1); expect([...seen.receipts.entries()]).toEqual(receiptsBefore); expect(seen.financialWrites).toEqual([]);
});

test('responsável inativada só pode ser substituída depois de resposta conhecida ao protocolo pendente', async ({ page }) => {
  const seen = await setup(page, { unassignedCustomers: 'all', inactiveAfterUncertainCommit: true }); await analyze(page); await owner(page).selectOption(collectorA); await reanalyze(page); page.once('dialog', dialog => dialog.accept()); await commitButton(page).click(); await expect(page.getByText('A confirmação está pendente.', { exact: false })).toBeVisible(); expect(seen.imports.size).toBe(0); expect(seen.assignmentApplications).toHaveLength(0);
  await expect(owner(page)).toBeDisabled(); await expect(analyzeButton(page)).toBeDisabled(); const previewsBefore=seen.previews.length;
  await pendingButton(page).click(); await expect(page.getByRole('alert').filter({ hasText: 'Confira a responsável de cada cliente sem carteira' })).toBeVisible();
  expect(seen.commits).toHaveLength(2); expect(seen.commits[1]).toEqual(seen.commits[0]); expect(seen.previews).toHaveLength(previewsBefore); expect(seen.imports.size).toBe(0); expect(seen.assignmentApplications).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Conferência de Contas a Receber', exact: true })).toHaveCount(0); await expect(pendingButton(page)).toHaveCount(0); await expect(page.getByLabel('Relatório de abertos e vencidos de Contas a Receber', { exact: true })).toBeEnabled();
  // A known rejection ends the frozen request. The operator deliberately
  // selects the same original again and checks the replacement assignment.
  await analyze(page); await expect(owner(page)).toBeEnabled(); await expect(owner(page)).toHaveValue(''); await expect(owner(page).locator(`option[value="${collectorA}"]`)).toHaveCount(0);
  await owner(page).selectOption(collectorB); await expect(commitButton(page)).toBeDisabled(); await reanalyze(page); await expect(commitButton(page)).toBeEnabled(); await commit(page);
  expect(seen.commits).toHaveLength(3); expect(seen.commits[2].request_id).not.toBe(seen.commits[0].request_id); expect(seen.commits[2].collector_mappings).toEqual({ [defaultKey]: collectorB }); expect(seen.commits[2].file_base64).toBe(seen.commits[0].file_base64); expect(seen.imports.size).toBe(1); expect(seen.assignmentApplications).toEqual([{ customer_key: defaultKey, collector_id: collectorB, row_count: 1 }]); expect(seen.receipts.size).toBe(0); expect(seen.financialWrites).toEqual([]);
});
