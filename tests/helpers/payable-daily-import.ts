import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { isChequeNumberHeader, parseCsv, readPayableChequeCell, validatePayableDailyRows } from '../../src/lib/payables-parser.mjs';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
export const dailyUuid = (value: number) => `58000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
export const dailyDate = '2026-10-30';
export const dailyCsv = 'Nº Lançamento;Histórico;Vencimento;Valor;Plano de Contas;Banco;Filial;Situação;Cheque: número\r\n14;Fornecedor sintético;16/10/2026;1.234,56;ENERGIA;Banco sintético;3;ABERTO;';
export const dailyChequeCsv = dailyCsv.replace(';ABERTO;', ';CHEQUE;000123');
export interface DailyFixtureOptions {
  missing?: number; firstReport?: boolean; unclassified?: boolean; reopened?: boolean; changed?: boolean;
  uncertain?: boolean; invalidCommit?: boolean; stale?: boolean; deferred?: boolean; activationRequired?: boolean; alreadyWrittenOff?: boolean;
  malformed?: 'hash' | 'count' | 'date' | 'partition' | 'version' | 'rounding' | 'financial';
}
export async function setupDailyImport(page: Page, options: DailyFixtureOptions = {}) {
  const fixedNow = new Date('2026-10-30T15:00:00Z');
  await page.clock.setFixedTime(fixedNow);
  const id = dailyUuid(1), claims = { sub: id, session_id: dailyUuid(2), exp: Math.floor(fixedNow.getTime() / 1000) + 3600, iat: Math.floor(fixedNow.getTime() / 1000), role: 'authenticated' };
  const access = { profile: { id, username: 'PessoaTeste', display_name: 'Pessoa de Teste', role_key: 'gerente_geral', enabled: true }, permissions: ['painel', 'caixa', 'contas_pagar', 'contas_receber', 'importar_bases'].flatMap(resource => [{ resource, action: 'read' }, ...(resource.startsWith('contas_') ? [{ resource, action: 'write' }, { resource, action: 'import' }] : [])]), collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-test-only'].join('.');
  const seen = { previews: [] as any[], commits: [] as any[], payments: [] as any[], writeoffs: [] as string[], otherWrites: [] as string[], results: new Map<string, any>(), release: () => {} };
  let currentHeadHash: string | null = null;
  const gate = new Promise<void>(resolve => { seen.release = resolve; });
  await page.route(`${project}/**`, async route => {
    const req = route.request(), url = new URL(req.url()), body = req.postDataJSON();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range', 'content-range': '*/0' };
    const reply = (json: any, status = 200) => route.fulfill({ status, headers, json });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/functions/v1/auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id, aud: 'authenticated', role: 'authenticated', email: 'synthetic@test.invalid', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} });
    if (url.pathname === '/rest/v1/rpc/current_access') return reply(access);
    if (url.pathname === '/rest/v1/rpc/cash_position') return reply({ accounts: [], total_cents: null, reported_accounts: 0, expected_accounts: 17, latest_position_date: null });
    if (url.pathname === '/rest/v1/rpc/current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (url.pathname === '/rest/v1/rpc/payables_summary' || url.pathname === '/rest/v1/rpc/receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null });
    if (url.pathname === '/functions/v1/payables-import') {
      expect(body.mode).toBe('open_status'); expect(body.status_report_version).toBe('061'); expect(body.report_kind).toBe('ALL'); expect(body.bank_mappings).toBeUndefined();
      const bytes = Buffer.from(body.file_base64, 'base64'); let matrix: unknown[][];
      if (body.file_name.endsWith('.csv')) matrix = parseCsv(bytes.toString('utf8'));
      else {
        const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes); const sheet = book.worksheets[0], chequeColumns: number[] = [];
        sheet.getRow(1).eachCell((cell, column) => { if (isChequeNumberHeader(cell.value)) chequeColumns.push(column); });
        matrix = []; sheet.eachRow((row, index) => { const values = (row.values as unknown[]).slice(1); if (index > 1) for (const column of chequeColumns) { const cell = row.getCell(column); values[column - 1] = readPayableChequeCell(cell.value, cell.numFmt); } matrix.push(values); });
      }
      const parsed = validatePayableDailyRows(matrix, { allowEmptyReport: body.empty_report_confirmed === true, roundProvisionedAmounts: true });
      if (parsed.errors.length) return reply({ errors: parsed.errors }, 422);
      const rows = parsed.rows.map((row: any) => Object.fromEntries(Object.entries(row).reverse()));
      const fileHash = createHash('sha256').update(bytes).digest('hex'), sameHead = currentHeadHash === fileHash;
      if (options.activationRequired) return reply({ code: 'P0061', activation_required: true }, 409);
      const statusActions: any[] = options.firstReport || sameHead ? [] : Array.from({ length: options.missing ?? 1 }, (_, index) => ({ kind: 'PAID', title_id: dailyUuid(100 + index), source_key: JSON.stringify(['3', `AUSENTE-${index}`]), amount_cents: 10000 + index }));
      if (options.reopened) statusActions.push({ kind: 'REOPEN', title_id: dailyUuid(900), source_key: JSON.stringify([rows[0].branch, rows[0].entry_number]), amount_cents: rows[0].amount_cents });
      const exceptions = rows.flatMap((row: any, index: number) => row.amount_cents === 1 ? [{ key: `row:${index + 1}`, kind: 'CENT', line: index + 1, title_id: null, branch: row.branch, entry_number: row.entry_number, description: row.description, due_date: row.due_date, cheque_number: row.cheque_number ?? null, amount_cents: 1, allowed_actions: options.alreadyWrittenOff ? [] : ['WRITE_OFF'], requires_resolution: !options.alreadyWrittenOff, already_written_off: !!options.alreadyWrittenOff, selected_action: options.alreadyWrittenOff ? null : body.resolution_choices[`row:${index + 1}`]?.action ?? null, problem: options.alreadyWrittenOff || body.resolution_choices[`row:${index + 1}`]?.action === 'WRITE_OFF' ? null : 'Confirme esta baixa individualmente, sem pagamento.' }] : []);
      const changed = options.changed ? 1 : 0, openCount = sameHead || options.changed || options.reopened ? rows.length : 0;
      const preview: any = { status_report_version: '061', mode: 'open_status', status_only: true, report_kind: 'ALL', report_date: dailyDate, empty_report_confirmed: body.empty_report_confirmed === true, previous_import_id: dailyUuid(500), financial_revision: 'revision-61', rows, row_count: rows.length, new_count: rows.length - openCount, open_count: openCount, changed_count: changed, baseline_only: !!options.firstReport && currentHeadHash === null, baseline_origin: options.firstReport && currentHeadHash === null ? 'FIRST_REPORT' : 'PREVIOUS_REPORT', marked_paid_count: statusActions.filter(item => item.kind === 'PAID').length, marked_paid_cents: statusActions.filter(item => item.kind === 'PAID').reduce((sum, item) => sum + item.amount_cents, 0), reopened_count: statusActions.filter(item => item.kind === 'REOPEN').length, status_actions: statusActions, exceptions, unmapped_plans: options.unclassified ? [{ plan: 'ENERGIA', count: rows.length, total_cents: rows.reduce((sum: number, row: any) => sum + row.amount_cents, 0) }] : [], macro_options: ['FIXO', 'NÃO CLASSIFICADO'], errors: exceptions.filter((item: any) => item.problem !== null).map((item: any) => ({ line: item.line ?? 0, column: 'Baixa sem pagamento', problem: item.problem, correction: 'Confirme somente o marcador de um centavo indicado.' })), can_commit: exceptions.every((item: any) => item.problem === null), rounding_adjustments: parsed.rounding_adjustments ?? [] };
      if (body.action === 'preview') {
        seen.previews.push(body); if (options.deferred) await gate;
        if (options.malformed === 'count') preview.marked_paid_count++;
        if (options.malformed === 'date') preview.report_date = '2026-02-30';
        if (options.malformed === 'partition') rows[0].amount_cents++;
        if (options.malformed === 'version') preview.status_report_version = '060';
        if (options.malformed === 'rounding') preview.rounding_adjustments = [];
        if (options.malformed === 'financial') statusActions[0].paid_on = dailyDate;
        return reply({ rows, preview, file_sha256: options.malformed === 'hash' ? '0'.repeat(64) : fileHash });
      }
      seen.commits.push(structuredClone(body));
      if (seen.results.has(body.request_id)) return reply({ ...seen.results.get(body.request_id), idempotent: true });
      if (options.stale) return reply({ code: '40001' }, 409);
      if (!preview.can_commit || body.expected_report_date !== dailyDate || body.previous_financial_revision !== 'revision-61') return reply({ code: '23514' }, 409);
      const writeoffs = Object.entries(body.resolution_choices).filter(([, choice]: any) => choice.action === 'WRITE_OFF').map(([key]) => key); seen.writeoffs.push(...writeoffs);
      const result = { status_report_version: '061', mode: 'open_status', status_only: true, report_kind: 'ALL', report_date: dailyDate, empty_report_confirmed: body.empty_report_confirmed === true, request_id: body.request_id, report_id: dailyUuid(700 + seen.results.size), import_id: dailyUuid(701), row_count: rows.length, new_count: preview.new_count, open_count: preview.open_count, updated_count: preview.changed_count, marked_paid_count: preview.marked_paid_count, marked_paid_cents: preview.marked_paid_cents, reopened_count: preview.reopened_count, paid_count: 0, payment_cents: 0, payments_created: 0, written_off_count: writeoffs.length, baseline_only: preview.baseline_only, idempotent: false, rounding_adjustments: preview.rounding_adjustments };
      seen.results.set(body.request_id, result); currentHeadHash = fileHash;
      if (options.uncertain) return reply({ code: 'XX000' }, 503);
      if (options.invalidCommit) return reply({ ...result, payment_cents: 1 });
      return reply(result);
    }
    if (req.method() === 'GET') return reply([]);
    if (url.pathname.startsWith('/rest/v1/rpc/')) return reply({ code: 'PGRST202' }, 404);
    seen.otherWrites.push(url.pathname); throw new Error(`Unexpected daily fixture request ${req.method()} ${url.pathname}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('PessoaTeste'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true }).click(); return seen;
}
export async function selectDailyFile(page: Page, content = dailyCsv, cheque = false) {
  await page.getByLabel('Relatório completo diário de Contas a Pagar', { exact: true }).setInputFiles({ name: cheque ? 'cheques.csv' : 'diario.csv', mimeType: 'text/csv', buffer: Buffer.from(content) });
}
