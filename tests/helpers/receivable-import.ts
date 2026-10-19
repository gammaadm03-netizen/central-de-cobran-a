import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { parseCsv, validateReceivableRows, validateReceivablePaidRows, isReceivableIdentifierHeader, readReceivableIdentifierCell } from '../../src/lib/receivables-parser.mjs';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
export const openCsv = 'Documento: número;Entidade 1 - Entidade: nome;Filial;Vencimento: data;Emissão: valor do lançamento;Emissão: data;CNPJ\r\n00014;Cliente sintético;3;16/10/2026 00:00;1.234,56;01/10/2026 00:00;12.345.678/0001-90';
export const receivedCsv = `${openCsv.split('\r\n')[0]};Quitação: data do recebimento;Quitação: valor recebido\r\n${openCsv.split('\r\n')[1]};17/10/2026 12:30;1.200,00`;
export const candidateId = '50000000-0000-4000-8000-000000000001';
export const collectorA = '60000000-0000-4000-8000-000000000001';
export const collectorB = '60000000-0000-4000-8000-000000000002';
export const collectorNames = { [collectorA]: 'Responsável sintética A', [collectorB]: 'Responsável sintética B' };
export function receivableCustomerKey(row: { client_document: string | null; client_name: string }) { return row.client_document ? `cnpj:${row.client_document}` : `name:${row.client_name.trim().replace(/\s+/g, ' ').toUpperCase()}`; }
export interface FixtureOptions { stale?: boolean; serverInvalid?: boolean; validatedPresent?: boolean; ambiguous?: number; ambiguousLines?: number[]; ignoreTitleMappings?: boolean; mappingConflict?: boolean; invalidMappedPreview?: boolean; correction?: boolean; matched?: boolean; historical?: boolean; conflict?: boolean; activationMissing?: boolean; uncertainCommit?: boolean; deferCommit?: boolean; legacyPreview?: boolean; tamperHash?: boolean; unassignedCustomers?: 'all' | string[]; missingCollectorMetadata?: boolean; agentsEmpty?: boolean; agentsFailure?: boolean; collectorOwners?: Record<string, string>; paidAfterUncertainCommit?: boolean; inactiveAfterUncertainCommit?: boolean }
export async function setupReceivableImport(page: Page, options: FixtureOptions = {}) {
  const id = '10000000-0000-4000-8000-000000000001';
  const access = { profile: { id, username: 'UsuarioTeste', display_name: 'Pessoa Teste', role_key: 'contas_receber', enabled: true }, permissions: [{ resource: 'painel', action: 'read' }, { resource: 'contas_receber', action: 'read' }, { resource: 'contas_receber', action: 'import' }, { resource: 'importar_bases', action: 'read' }], collector_id: null };
  const claims = { sub: id, session_id: '20000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), role: 'authenticated' };
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-test-only'].join('.');
  const user = { id, aud: 'authenticated', role: 'authenticated', email: 'synthetic@test.invalid', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} };
  const owners = new Map<string, string | null>(), importHashes = new Set<string>();
  const scenario = { paid: false, inactiveChoice: false };
  const receipts = new Map<string, { title_id: string; amount_cents: number; payment_date: string }>();
  const seen = { owners, imports: importHashes, receipts, rejectedCollectorPreviews: 0, assignmentApplications: [] as { customer_key: string; collector_id: string; row_count: number }[], reads: [] as { path: string; query: string }[], previews: [] as any[], commits: [] as any[], financialWrites: [] as string[], releaseCommit: () => {} };
  let imported = false, lastCount = 1, lastMode = 'open';
  let lastGroups: { customer_key: string; client_name: string; client_document: string | null; row_count: number }[] = [];
  const commitGate = new Promise<void>(resolve => { seen.releaseCommit = resolve; });
  await page.route(`${project}/**`, async route => {
    const req = route.request(), url = new URL(req.url()), body = req.postDataJSON();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range' };
    const reply = (json: any, status = 200) => route.fulfill({ status, headers: { ...headers, 'content-range': '*/0' }, json });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/functions/v1/auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply(user);
    if (url.pathname === '/rest/v1/rpc/current_access') return reply(access);
    if (['/rest/v1/rpc/receivables_management_summary', '/rest/v1/rpc/collections_overdue_summary'].includes(url.pathname)) return reply({ code: 'PGRST202' }, 404);
    if (url.pathname === '/rest/v1/rpc/cash_position') return reply({ accounts: [], total_cents: null, reported_accounts: 0, expected_accounts: 17, latest_position_date: null });
    if (url.pathname === '/rest/v1/rpc/current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (url.pathname === '/rest/v1/rpc/payables_summary' || url.pathname === '/rest/v1/rpc/receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null });
    if (url.pathname === '/rest/v1/director_positions') return reply([]);
    if (req.method() === 'GET') seen.reads.push({ path: url.pathname, query: url.search });
    if (url.pathname === '/rest/v1/collection_agents') return options.agentsFailure ? reply({ code: '42501' }, 403) : reply(options.agentsEmpty ? [] : [...(!scenario.inactiveChoice ? [{ id: collectorA, display_name: collectorNames[collectorA], enabled: true }] : []), { id: collectorB, display_name: collectorNames[collectorB], enabled: true }]);
    if (url.pathname === '/rest/v1/receivable_imports') return reply(imported ? [{ id: '40000000-0000-4000-8000-000000000001', created_at: '2026-10-17T12:00:00Z', file_name: 'cr.csv', row_count: lastCount, new_count: 1, open_count: 0, pending_count: 0, validated_in_source_count: 0, import_mode: lastMode === 'received' ? 'RECEIVED' : 'OPEN' }] : []);
    if (url.pathname === '/functions/v1/receivables-import') {
      if (body.action === 'preview') {
        seen.previews.push(body);
        if (options.activationMissing) return reply({ code: body.mode === 'received' ? 'P0024' : 'P0023', activation_required: true }, 409);
        if (body.mode === 'open' && Object.keys(body.collector_mappings ?? {}).length && (scenario.paid || scenario.inactiveChoice && Object.values(body.collector_mappings).includes(collectorA))) { seen.rejectedCollectorPreviews++; return reply({ code: '23514', error: 'stale collector choice synthetic details' }, 409); }
        if (options.serverInvalid) return reply({ code: '22023', errors: [{ line: 2, column: 'CNPJ', problem: 'CNPJ deve conter exatamente 14 dígitos. Não complete zeros automaticamente.', correction: 'Corrija a célula no arquivo original e selecione uma nova cópia.' }], error: 'private stack trace' }, 422);
        const bytes = Buffer.from(body.file_base64, 'base64'); let matrix: unknown[][];
        if (body.file_name.endsWith('.csv')) matrix = parseCsv(bytes.toString('utf8'));
        else {
          const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes); const sheet = workbook.worksheets[0]; matrix = [];
          const identifiers: number[] = []; sheet.getRow(1).eachCell((cell, col) => { if (isReceivableIdentifierHeader(cell.value)) identifiers.push(col); });
          for (let index = 1; index <= sheet.rowCount; index++) {
            const row = sheet.getRow(index), values = (row.values as unknown[]).slice(1);
            if (index > 1) for (const col of identifiers) values[col - 1] = readReceivableIdentifierCell(row.getCell(col).value, row.getCell(col).numFmt);
            matrix.push(values);
          }
        }
        const parsed = body.mode === 'received' ? validateReceivablePaidRows(matrix) : validateReceivableRows(matrix);
        if (parsed.errors.length) return reply({ errors: parsed.errors }, 422);
        const rows = parsed.rows.map((row, index) => {
          const line = index + 1, hasCandidate = options.ambiguousLines?.includes(line) ?? index < (options.ambiguous ?? 0);
          const ambiguous = hasCandidate && (options.ignoreTitleMappings || !body.title_mappings?.[String(line)]);
          const outcome = options.conflict || options.mappingConflict && body.title_mappings?.[String(line)] ? 'CONFLICT' : ambiguous ? 'AMBIGUOUS' : body.mode === 'received' ? options.correction ? 'CORRECTION' : options.historical || body.title_mappings?.[String(line)] === 'NEW' ? 'HISTORICAL' : options.matched || imported ? 'MATCHED' : 'NEW_RECEIPT' : options.validatedPresent || imported ? 'MATCHED' : body.title_mappings?.[String(line)] && body.title_mappings[String(line)] !== 'NEW' ? 'UPDATE' : 'NEW';
          return { ...row, customer_key: receivableCustomerKey(row), line, title_id: outcome === 'NEW' || outcome === 'HISTORICAL' ? null : candidateId, outcome, candidates: hasCandidate ? [{ id: candidateId, due_date: '2026-10-15', amount_cents: row.amount_cents, status: 'OPEN', collector_id: null }] : [] };
        });
        const ambiguous = rows.filter(row => row.outcome === 'AMBIGUOUS').length;
        const conflict = rows.filter(row => row.outcome === 'CONFLICT').length;
        const preview: any = { mode: body.mode, previous_import_id: imported ? '40000000-0000-4000-8000-000000000001' : null, financial_revision: imported ? '18' : '17', row_count: rows.length,
          new_count: body.mode === 'received' ? rows.filter(row => row.outcome === 'HISTORICAL').length : rows.filter(row => row.outcome === 'NEW').length,
          open_count: options.validatedPresent || scenario.paid ? 0 : rows.filter(row => row.outcome === 'UPDATE' || row.outcome === 'MATCHED').length, changed_count: rows.filter(row => row.outcome === 'UPDATE').length,
          pending_count: 0, validated_in_source_count: options.validatedPresent || scenario.paid ? rows.length : 0,
          received_count: rows.filter(row => ['NEW_RECEIPT', 'HISTORICAL'].includes(row.outcome)).length, matched_count: rows.filter(row => row.outcome === 'MATCHED').length,
          correction_count: rows.filter(row => row.outcome === 'CORRECTION').length, historical_count: rows.filter(row => row.outcome === 'HISTORICAL').length,
          conflict_count: conflict, can_commit: ambiguous === 0 && conflict === 0,
          rows,
          errors: rows.filter(row => row.outcome === 'AMBIGUOUS' || row.outcome === 'CONFLICT').map(row => ({ line: row.line, column: 'Documento / NF', problem: row.outcome === 'AMBIGUOUS' ? 'Escolha o vínculo da parcela antes de importar.' : 'Recebimento manual divergente. Nenhum registro será substituído.', correction: row.outcome === 'AMBIGUOUS' ? 'Selecione a parcela existente ou Nova parcela e analise novamente.' : 'Confira o recebimento com o financeiro.' })),
        };
        if (body.mode === 'open' && !options.missingCollectorMetadata) {
          const groups = new Map<string, typeof rows>();
          for (const row of rows) { const group = groups.get(row.customer_key) ?? []; group.push(row); groups.set(row.customer_key, group); }
          lastGroups = [...groups].map(([customer_key, group]) => ({ customer_key, client_name: group[0].client_name, client_document: group[0].client_document, row_count: group.length }));
          const assignments = lastGroups.map(group => {
            if (!owners.has(group.customer_key)) owners.set(group.customer_key, options.collectorOwners?.[group.customer_key] ?? (options.unassignedCustomers === 'all' || options.unassignedCustomers?.includes(group.customer_key) ? null : collectorA));
            const existing = owners.get(group.customer_key), selected = body.collector_mappings?.[group.customer_key];
            if (scenario.paid) return { ...group, collector_id: null, collector_name: null, requires_selection: false, locked: false };
            const resolved = existing ?? selected ?? null;
            return { ...group, collector_id: resolved, collector_name: resolved ? collectorNames[resolved as keyof typeof collectorNames] : null, requires_selection: !existing, locked: !!existing };
          });
          preview.collector_assignment_version = '030'; preview.customer_collector_assignments = assignments;
          preview.missing_collector_count = assignments.filter(item => item.requires_selection && !item.collector_id).length;
          preview.can_commit = preview.can_commit && preview.missing_collector_count === 0;
        }
        if (options.invalidMappedPreview && Object.keys(body.title_mappings ?? {}).length) { preview.errors = []; preview.can_commit = true; }
        lastCount = rows.length; lastMode = body.mode;
        return reply({ rows, file_sha256: options.tamperHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), preview: options.legacyPreview ? { previous_import_id: null, row_count: rows.length, new_count: rows.length, open_count: 0, pending_count: 2, validated_in_source_count: 0 } : preview });
      }
      seen.commits.push(body);
      if (options.deferCommit) await commitGate;
      if (options.stale) return reply({ code: '40001', error: 'private SQL details' }, 409);
      if (options.inactiveAfterUncertainCommit && seen.commits.length === 1) { scenario.inactiveChoice = true; return reply({ error: 'unavailable' }, 503); }
      if (body.mode === 'open') {
        for (const group of lastGroups) {
          const existing = owners.get(group.customer_key), selected = body.collector_mappings?.[group.customer_key];
          if (existing && selected && selected !== existing) return reply({ code: '23514' }, 409);
          if (!existing && !selected) return reply({ code: 'P0030' }, 409);
        }
        for (const group of lastGroups) if (!owners.get(group.customer_key)) {
          owners.set(group.customer_key, body.collector_mappings[group.customer_key]);
          seen.assignmentApplications.push({ customer_key: group.customer_key, collector_id: body.collector_mappings[group.customer_key], row_count: group.row_count });
        }
      }
      importHashes.add(createHash('sha256').update(Buffer.from(body.file_base64, 'base64')).digest('hex'));
      imported = true;
      if (options.paidAfterUncertainCommit && seen.commits.length === 1) { scenario.paid = true; receipts.set(candidateId, { title_id: candidateId, amount_cents: 120000, payment_date: '2026-10-17' }); }
      if ((options.uncertainCommit || options.paidAfterUncertainCommit) && seen.commits.length === 1) return reply({ error: 'unavailable' }, 503);
      return reply({ import_id: '40000000-0000-4000-8000-000000000001', row_count: lastCount, new_count: 1, open_count: 0, pending_count: 0, validated_in_source_count: 0, idempotent: seen.commits.length > 1 });
    }
    if (req.method() !== 'GET') { seen.financialWrites.push(url.pathname); throw new Error(`Unexpected financial write ${url.pathname}`); }
    throw new Error(`Unexpected offline read ${url.pathname}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('UsuarioTeste'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central' }).click(); await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true }).click(); await page.getByRole('tab', { name: 'Contas a Receber', exact: true }).click();
  return seen;
}
export async function analyzeReceivableImport(page: Page, content = openCsv, mode: 'open' | 'received' = 'open') {
  const label = mode === 'open' ? 'Relatório de abertos e vencidos de Contas a Receber' : 'Relatório de títulos quitados de Contas a Receber';
  await page.getByLabel(label, { exact: true }).setInputFiles({ name: 'cr.csv', mimeType: 'text/csv', buffer: Buffer.from(content) });
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click();
}
