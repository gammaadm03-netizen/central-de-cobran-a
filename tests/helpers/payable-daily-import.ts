import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { isChequeNumberHeader, parseCsv, readPayableChequeCell, validatePayableDailyRows } from '../../src/lib/payables-parser.mjs';
import { validContentsCommit, validContentsPreview } from '../../supabase/functions/payables-import/report-contents-reconciliation.mjs';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
export const dailyUuid = (value: number) => `58000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
export const dailyDate = '2026-11-04';
export const dailyCsv = 'Nº Lançamento;Histórico;Vencimento;Valor;Plano de Contas;Banco;Filial;Situação;Cheque: número\r\n14;Fornecedor sintético;16/10/2026;1.234,56;ENERGIA;Banco sintético;3;ABERTO;';
export const dailyChequeCsv = dailyCsv.replace(';ABERTO;', ';CHEQUE;000123');
export type DailyContents = 'FULL_OPEN' | 'PAID_STATUS';
export interface DailyFixtureOptions {
  missing?: number; firstReport?: boolean; unclassified?: boolean; reopened?: boolean; changed?: boolean;
  uncertain?: boolean; invalidCommit?: boolean; stale?: boolean; deferred?: boolean; activationRequired?: boolean; alreadyWrittenOff?: boolean;
  largeReduction?: boolean; unknownPaid?: boolean; changeLargeReduction?: boolean;
  malformed?: 'hash' | 'count' | 'date' | 'partition' | 'version' | 'rounding' | 'financial' | 'contents' | 'position';
}
type Known = { row: any; id: string; paid: boolean; admin: boolean };
const keyOf = (row: any) => JSON.stringify([row.branch, row.entry_number]);
const different = (a: any, b: any) => ['description', 'plan', 'bank_account', 'source_status', 'amount_cents', 'due_date', 'issued_on', 'cheque_number'].some(key => (a[key] ?? null) !== (b[key] ?? null));

export async function setupDailyImport(page: Page, options: DailyFixtureOptions = {}) {
  const fixedNow = new Date('2026-11-04T15:00:00Z');
  await page.clock.setFixedTime(fixedNow);
  const id = dailyUuid(1), claims = { sub: id, session_id: dailyUuid(2), exp: Math.floor(fixedNow.getTime() / 1000) + 3600, iat: Math.floor(fixedNow.getTime() / 1000), role: 'authenticated' };
  const access = { profile: { id, username: 'PessoaTeste', display_name: 'Pessoa de Teste', role_key: 'gerente_geral', enabled: true }, permissions: ['painel', 'caixa', 'contas_pagar', 'contas_receber', 'importar_bases'].flatMap(resource => [{ resource, action: 'read' }, ...(resource.startsWith('contas_') ? [{ resource, action: 'write' }, { resource, action: 'import' }] : [])]), collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-test-only'].join('.');
  const known = new Map<string, Known>(), position = new Map<string, any>();
  const seen = { previews: [] as any[], commits: [] as any[], payments: [] as any[], writeoffs: [] as string[], otherWrites: [] as string[], results: new Map<string, any>(), known, position, release: () => {} };
  let seededSource = false;
  let titleNumber = 1000, revisionNumber = 0;
  const missing = options.firstReport ? 0 : options.largeReduction ? 100 : options.missing ?? 1;
  for (let index = 0; index < missing; index++) {
    const row = { branch: '3', entry_number: `AUSENTE-${index}`, amount_cents: 10000 + index, description: 'Fornecedor ausente sintético', plan: 'ENERGIA', bank_account: 'Banco sintético', source_status: 'ABERTO', due_date: '2026-10-16', issued_on: null };
    const key = keyOf(row); known.set(key, { row, id: dailyUuid(100 + index), paid: false, admin: false }); position.set(key, row);
  }
  let headExists = !options.firstReport;
  const gate = new Promise<void>(resolve => { seen.release = resolve; });
  await page.route(`${project}/**`, async route => {
    const req = route.request(), url = new URL(req.url()), body = req.postDataJSON();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:4173', 'access-control-allow-headers': 'apikey,content-type,authorization,x-client-info,prefer', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range', 'content-range': '*/0' };
    const reply = (json: any, status = 200) => route.fulfill({ status, headers, json });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/functions/v1/auth-gateway') return reply({ session: { access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'bearer' }, access });
    if (url.pathname === '/auth/v1/user') return reply({ id, aud: 'authenticated', role: 'authenticated', email: 'synthetic@test.invalid', created_at: fixedNow.toISOString(), app_metadata: {}, user_metadata: {} });
    if (url.pathname === '/rest/v1/rpc/current_access') return reply(access);
    if (url.pathname === '/rest/v1/rpc/cash_position') return reply({ accounts: [], total_cents: null, reported_accounts: 0, expected_accounts: 17, latest_position_date: null });
    if (url.pathname === '/rest/v1/rpc/current_stock') return reply({ value_cents: null, reference_date: null, source: null });
    if (url.pathname === '/rest/v1/rpc/payables_summary' || url.pathname === '/rest/v1/rpc/receivables_summary') return reply({ open_cents: 0, overdue_cents: 0, period_cents: 0, active_count: 0, latest_import_at: null });
    if (url.pathname === '/functions/v1/payables-import') {
      expect(body.mode).toBe('open_status'); expect(body.status_report_version).toBe('065'); expect(body.report_kind).toBe('ALL'); expect(['FULL_OPEN', 'PAID_STATUS']).toContain(body.report_contents); expect(body.bank_mappings).toBeUndefined();
      const contents: DailyContents = body.report_contents, bytes = Buffer.from(body.file_base64, 'base64'); let matrix: unknown[][];
      if (body.file_name.endsWith('.csv')) matrix = parseCsv(bytes.toString('utf8'));
      else {
        const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes); const sheet = book.worksheets[0], chequeColumns: number[] = [];
        sheet.getRow(1).eachCell((cell, column) => { if (isChequeNumberHeader(cell.value)) chequeColumns.push(column); });
        matrix = []; sheet.eachRow((row, index) => { const values = (row.values as unknown[]).slice(1); if (index > 1) for (const column of chequeColumns) { const cell = row.getCell(column); values[column - 1] = readPayableChequeCell(cell.value, cell.numFmt); } matrix.push(values); });
      }
      const parsed = validatePayableDailyRows(matrix, { allowEmptyReport: body.empty_report_confirmed === true, roundProvisionedAmounts: true });
      if (parsed.errors.length) return reply({ errors: parsed.errors }, 422);
      const rows = parsed.rows.map((row: any) => Object.fromEntries(Object.entries(row).reverse()));
      const fileHash = createHash('sha256').update(bytes).digest('hex');
      if (options.activationRequired) return reply({ code: 'P0065', activation_required: true }, 409);
      if (body.action === 'commit') {
        const original = seen.commits.find(item => item.request_id === body.request_id);
        seen.commits.push(structuredClone(body));
        if (seen.results.has(body.request_id)) { expect(body).toEqual(original); return reply({ ...seen.results.get(body.request_id), idempotent: true }); }
      }
      if (!seededSource) {
        seededSource = true;
        for (const row of rows) if (options.changed || options.reopened || options.alreadyWrittenOff || contents === 'PAID_STATUS' && !options.unknownPaid) {
          const key = keyOf(row), old = options.changed ? { ...row, amount_cents: row.amount_cents + 1 } : { ...row };
          known.set(key, { row: old, id: dailyUuid(++titleNumber), paid: !!options.reopened, admin: !!options.alreadyWrittenOff && row.amount_cents === 1 });
          if (!options.reopened) position.set(key, old);
        }
      }
      const sourceKeys = new Set(rows.map(keyOf)), statusActions: any[] = [];
      const alreadyClosedKeys: string[] = [];
      const previousCount = position.size;
      const removed = contents === 'FULL_OPEN' ? [...position.keys()].filter(key => !sourceKeys.has(key)).length : [...position.keys()].filter(key => sourceKeys.has(key)).length;
      if (contents === 'FULL_OPEN') {
        for (const [key, row] of position) {
          const title = known.get(key)!;
          if (!sourceKeys.has(key) && !title.paid && !title.admin && row.amount_cents !== 1) statusActions.push({ kind: 'PAID', title_id: title.id, source_key: key, amount_cents: row.amount_cents });
        }
        for (const row of rows) {
          const title = known.get(keyOf(row));
          if (title?.paid && row.amount_cents !== 1) statusActions.push({ kind: 'REOPEN', title_id: title.id, source_key: keyOf(row), amount_cents: row.amount_cents });
        }
      } else {
        for (const row of rows) {
          const title = known.get(keyOf(row));
          if (!title) continue;
          if ((title.paid || title.admin) && row.amount_cents !== 1) alreadyClosedKeys.push(keyOf(row));
          else if (row.amount_cents !== 1) statusActions.push({ kind: 'PAID', title_id: title.id, source_key: keyOf(row), amount_cents: title.row.amount_cents });
        }
      }
      const exceptions = rows.flatMap((row: any, index: number) => {
        const title = known.get(keyOf(row));
        if (row.amount_cents !== 1 || contents === 'PAID_STATUS' && !title) return [];
        const written = !!title?.admin, selected = written ? null : body.resolution_choices[`row:${index + 1}`]?.action ?? null;
        return [{ key: `row:${index + 1}`, kind: 'CENT', line: index + 1, title_id: title?.id ?? null, branch: row.branch, entry_number: row.entry_number, description: row.description, due_date: row.due_date, cheque_number: row.cheque_number ?? null, amount_cents: 1, allowed_actions: written ? [] : ['WRITE_OFF'], requires_resolution: !written, already_written_off: written, selected_action: selected, problem: written || selected === 'WRITE_OFF' ? null : 'Confirme esta baixa individualmente, sem pagamento.' }];
      });
      const newCount = rows.filter((row: any) => !known.has(keyOf(row))).length;
      const changed = contents === 'PAID_STATUS' ? 0 : rows.filter((row: any) => { const old = known.get(keyOf(row)); return old && different(old.row, row); }).length;
      const requiresLarge = contents === 'FULL_OPEN' && previousCount >= 20 && removed * 2 > previousCount;
      const largeConfirmed = body.confirm_large_reduction === true;
      const largeProblem = requiresLarge && !largeConfirmed ? 'Confirme que este relatório contém todos os títulos em aberto, apesar da redução indicada.' : null;
      const errors: any[] = exceptions.filter((item: any) => item.problem !== null).map((item: any) => ({ line: item.line ?? 0, column: 'Baixa sem pagamento', problem: item.problem, correction: 'Confirme somente o marcador de um centavo indicado.' }));
      if (largeProblem) errors.push({ line: 0, column: 'Abrangência do relatório', code: 'LARGE_REDUCTION_CONFIRMATION', problem: largeProblem, correction: 'Confira o relatório completo antes de confirmar a redução.' });
      if (contents === 'PAID_STATUS') for (const [index, row] of rows.entries()) if (!known.has(keyOf(row))) errors.push({ line: index + 1, column: 'Lançamento / filial', problem: 'Título baixado não cadastrado na previsão.', correction: 'Confira a identificação e a base já importada.' });
      const preview: any = { status_report_version: '065', mode: 'open_status', status_only: true, report_kind: 'ALL', report_contents: contents, report_date: dailyDate, empty_report_confirmed: body.empty_report_confirmed === true, previous_import_id: dailyUuid(500 + revisionNumber), financial_revision: `revision-65-${revisionNumber}`, rows, source_row_count: rows.length, row_count: rows.length, new_count: newCount, open_count: rows.length - newCount, changed_count: changed, baseline_only: !headExists, baseline_origin: headExists ? 'PREVIOUS_REPORT' : 'FIRST_REPORT', marked_paid_count: statusActions.filter(item => item.kind === 'PAID').length, marked_paid_cents: statusActions.filter(item => item.kind === 'PAID').reduce((sum, item) => sum + item.amount_cents, 0), reopened_count: statusActions.filter(item => item.kind === 'REOPEN').length, status_actions: statusActions, exceptions, paid_already_closed_keys: alreadyClosedKeys, paid_already_closed_count: alreadyClosedKeys.length, paid_unknown_keys: contents === 'PAID_STATUS' ? rows.filter((row: any) => !known.has(keyOf(row))).map(keyOf) : [], unmapped_plans: options.unclassified ? [{ plan: rows[0]?.plan ?? 'ENERGIA', count: rows.length, total_cents: rows.reduce((sum: number, row: any) => sum + row.amount_cents, 0) }] : [], macro_options: ['FIXO', 'NÃO CLASSIFICADO'], errors, can_commit: errors.length === 0, rounding_adjustments: parsed.rounding_adjustments ?? [], previous_position_count: previousCount, removed_from_position_count: removed, position_count: contents === 'FULL_OPEN' ? rows.length : previousCount - removed, requires_large_reduction_confirmation: requiresLarge, large_reduction_confirmed: largeConfirmed, large_reduction_problem: largeProblem };
      expect(validContentsPreview(preview, { sourceRows: rows, resolutionChoices: body.resolution_choices, roundingAdjustments: parsed.rounding_adjustments ?? [], reportContents: contents, emptyReportConfirmed: body.empty_report_confirmed === true, confirmLargeReduction: largeConfirmed }), 'Synthetic preview must satisfy the production 065 proof before any intentional tampering').toBe(true);
      if (body.action === 'preview') {
        seen.previews.push(structuredClone(body)); if (options.deferred) await gate;
        if (options.changeLargeReduction && body.confirm_large_reduction && seen.previews.length > 1) preview.financial_revision = 'revision-65-concurrent';
        if (options.malformed === 'count') preview.marked_paid_count++;
        if (options.malformed === 'date') preview.report_date = '2026-02-30';
        if (options.malformed === 'partition' && rows[0]) rows[0].amount_cents++;
        if (options.malformed === 'version') preview.status_report_version = '061';
        if (options.malformed === 'rounding') preview.rounding_adjustments = [];
        if (options.malformed === 'financial' && statusActions[0]) statusActions[0].paid_on = dailyDate;
        if (options.malformed === 'contents') preview.report_contents = contents === 'FULL_OPEN' ? 'PAID_STATUS' : 'FULL_OPEN';
        if (options.malformed === 'position') preview.position_count++;
        return reply({ rows, preview, file_sha256: options.malformed === 'hash' ? '0'.repeat(64) : fileHash });
      }
      if (options.stale) return reply({ code: '40001' }, 409);
      if (!preview.can_commit || body.expected_report_date !== dailyDate || body.previous_financial_revision !== `revision-65-${revisionNumber}`) return reply({ code: '23514' }, 409);
      const writeoffs = Object.entries(body.resolution_choices).filter(([, choice]: any) => choice.action === 'WRITE_OFF').map(([key]) => key); seen.writeoffs.push(...writeoffs);
      for (const row of rows) if (contents === 'FULL_OPEN') {
        const key = keyOf(row), title = known.get(key); known.set(key, { row: { ...row }, id: title?.id ?? dailyUuid(++titleNumber), paid: false, admin: !!title?.admin && row.amount_cents === 1 });
      }
      for (const action of statusActions) known.get(action.source_key)!.paid = action.kind === 'PAID';
      for (const item of exceptions) if (writeoffs.includes(item.key)) known.get(keyOf(item))!.admin = true;
      if (contents === 'FULL_OPEN') { position.clear(); for (const row of rows) position.set(keyOf(row), { ...row }); }
      else for (const row of rows) position.delete(keyOf(row));
      const result = { status_report_version: '065', mode: 'open_status', status_only: true, report_kind: 'ALL', report_contents: contents, report_date: dailyDate, empty_report_confirmed: body.empty_report_confirmed === true, request_id: body.request_id, report_id: dailyUuid(700 + seen.results.size), import_id: dailyUuid(701 + seen.results.size), row_count: rows.length, source_row_count: rows.length, new_count: preview.new_count, open_count: preview.open_count, updated_count: preview.changed_count, marked_paid_count: preview.marked_paid_count, marked_paid_cents: preview.marked_paid_cents, reopened_count: preview.reopened_count, paid_count: 0, payment_cents: 0, payments_created: 0, written_off_count: writeoffs.length, baseline_only: preview.baseline_only, idempotent: false, rounding_adjustments: preview.rounding_adjustments, previous_position_count: previousCount, removed_from_position_count: removed, position_count: position.size, requires_large_reduction_confirmation: requiresLarge, large_reduction_confirmed: largeConfirmed, large_reduction_problem: null, paid_already_closed_keys: alreadyClosedKeys, paid_already_closed_count: alreadyClosedKeys.length, paid_unknown_keys: [] };
      expect(validContentsCommit(result, { sourceRows: rows, request: body, roundingAdjustments: parsed.rounding_adjustments ?? [] }), 'Synthetic result must satisfy the production 065 proof before any intentional tampering').toBe(true);
      seen.results.set(body.request_id, result); headExists = true; revisionNumber++;
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
export async function selectDailyFile(page: Page, content = dailyCsv, cheque = false, contents: DailyContents = 'FULL_OPEN') {
  await page.getByRole('radio', { name: contents === 'FULL_OPEN' ? 'Todos os títulos em aberto' : 'Somente títulos baixados', exact: true }).check();
  await page.getByLabel('Relatório diário de Contas a Pagar', { exact: true }).setInputFiles({ name: cheque ? 'cheques.csv' : 'diario.csv', mimeType: 'text/csv', buffer: Buffer.from(content) });
}
