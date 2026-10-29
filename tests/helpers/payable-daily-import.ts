import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { parseCsv, validatePayableDailyRows } from '../../src/lib/payables-parser.mjs';

const project = 'https://sjimddcqgrsauzvffcol.supabase.co';
export const dailyUuid = (value: number) => `58000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
export const dailyBank = { id: dailyUuid(90), display_name: 'Conta oficial sintética', company: 'Empresa sintética', bank: 'Banco sintético' };
export const dailyDate = '2026-10-29';
export const dailyBankKey = '["3", "Banco sintético"]';
export const dailyCsv = 'Nº Lançamento;Histórico;Vencimento;Valor;Plano de Contas;Banco;Filial;Situação;Cheque: número\r\n14;Fornecedor sintético;16/10/2026;1.234,56;ENERGIA;Banco sintético;3;ABERTO;';
export const dailyChequeCsv = dailyCsv.replace(';ABERTO;', ';CHEQUE;000123');
export interface DailyFixtureOptions {
  automatic?: number; firstCheques?: boolean; unknownBank?: boolean; unknownBankCount?: number; futureDue?: boolean; centNominal?: number; unclassified?: boolean;
  paidReappeared?: boolean; uncertain?: boolean; invalidCommit?: boolean; stale?: boolean; deferred?: boolean;
  malformed?: 'hash' | 'count' | 'date' | 'partition' | 'automatic-date' | 'automatic-bank' | 'version';
}
export async function setupDailyImport(page: Page, options: DailyFixtureOptions = {}) {
  await page.clock.setFixedTime(new Date('2026-10-29T15:00:00Z'));
  const id = dailyUuid(1), claims = { sub: id, session_id: dailyUuid(2), exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), role: 'authenticated' };
  const access = { profile: { id, username: 'PessoaTeste', display_name: 'Pessoa de Teste', role_key: 'gerente_geral', enabled: true }, permissions: ['painel', 'caixa', 'contas_pagar', 'contas_receber', 'importar_bases'].flatMap(resource => [{ resource, action: 'read' }, ...(resource.startsWith('contas_') ? [{ resource, action: 'write' }, { resource, action: 'import' }] : [])]), collector_id: null };
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-test-only'].join('.');
  const seen = { previews: [] as any[], commits: [] as any[], payments: [] as any[], writeoffs: [] as string[], otherWrites: [] as string[], results: new Map<string, any>(), release: () => {} };
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
      expect(body.mode).toBe('daily'); expect(body.daily_report_version).toBe('058');
      const bytes = Buffer.from(body.file_base64, 'base64'), parsed = validatePayableDailyRows(parseCsv(bytes.toString('utf8')), { allowEmptyCheques: body.empty_cheques_confirmed === true });
      if (parsed.errors.length) return reply({ errors: parsed.errors }, 422);
      const cheque = (row: any) => row.source_status === 'CHEQUE' || !!row.cheque_number;
      const source = body.report_kind === 'NORMAL' ? parsed.rows.filter((row: any) => !cheque(row)) : parsed.rows;
      const rows = source.map((row: any) => Object.fromEntries(Object.entries(row).reverse()));
      const rule = body.report_kind === 'CHEQUES' ? 'IMPORT_DATE' : 'DUE_DATE';
      const action = (index: number) => ({ key: `title:${dailyUuid(100 + index)}`, kind: 'MISSING', line: null, title_id: dailyUuid(100 + index), branch: '3', entry_number: `AUSENTE-${index + 1}`, description: `Fornecedor ausente sintético ${index + 1}`, due_date: options.futureDue ? '2026-11-04' : '2026-10-16', amount_cents: 10000 + index, payment_remaining_cents: 10000 + index, allowed_actions: ['PAID'], requires_resolution: false, already_written_off: false, problem: null, selected_action: 'PAID', paid_on: body.report_kind === 'CHEQUES' ? dailyDate : options.futureDue ? '2026-11-04' : '2026-10-16', bank_account_id: dailyBank.id, bank_label: dailyBank.display_name, cheque_number: body.report_kind === 'CHEQUES' ? `000${index + 1}` : null, rule, payment_revision: null, last_import_id: dailyUuid(500) });
      const mappedBank = body.bank_mappings?.[dailyBankKey] === dailyBank.id;
      const automatic: any[] = options.firstCheques || options.unknownBank && !mappedBank || options.futureDue ? [] : Array.from({ length: options.unknownBank ? options.unknownBankCount ?? 1 : options.automatic ?? 1 }, (_, index) => action(index));
      const exceptions: any[] = [];
      if (options.unknownBank && !mappedBank || options.futureDue) for (let index = 0; index < (options.unknownBankCount ?? 1); index++) exceptions.push({ ...action(index), requires_resolution: true, selected_action: null, problem: options.futureDue ? 'Vencimento futuro: confirme a data real do pagamento.' : 'Escolha a conta oficial deste pagamento.', ...(options.unknownBank ? { bank_account_id: null, bank_label: null, bank_mapping_key: dailyBankKey, source_bank: 'Banco sintético' } : {}) });
      rows.forEach((row: any, index: number) => {
        if (row.amount_cents === 1) exceptions.push({ ...action(600 + index), key: `row:${index + 1}`, kind: 'CENT', line: index + 1, title_id: options.centNominal ? dailyUuid(600 + index) : null, entry_number: row.entry_number, description: row.description, amount_cents: options.centNominal ?? 1, source_amount_cents: 1, payment_remaining_cents: options.centNominal ?? 1, paid_on: null, allowed_actions: ['WRITE_OFF'], requires_resolution: true, selected_action: null, problem: 'Confirme esta baixa individualmente, sem pagamento.', payment_revision: options.centNominal ? dailyUuid(1000 + index) : null, last_import_id: options.centNominal ? dailyUuid(500) : null });
      });
      if (options.paidReappeared) exceptions.push({ ...action(999), kind: 'REAPPEARED', line: 1, allowed_actions: [], requires_resolution: true, selected_action: null, problem: 'Título já possui pagamento: confira o histórico e estorne explicitamente antes de retornar.' });
      for (const item of exceptions) {
        const choice = body.resolution_choices[item.key];
        if (choice && item.allowed_actions.includes(choice.action)) { item.selected_action = choice.action; item.problem = null; }
      }
      const unclassified = options.unclassified && body.mappings.ENERGIA !== 'FIXO' ? [{ plan: 'ENERGIA', count: rows.length, total_cents: rows.reduce((sum: number, row: any) => sum + row.amount_cents, 0) }] : [];
      const preview: any = { daily_report_version: '058', mode: 'daily', report_kind: body.report_kind, report_date: dailyDate, empty_cheques_confirmed: body.empty_cheques_confirmed === true, previous_import_id: dailyUuid(500), financial_revision: 'revision-58', rows, row_count: rows.length, ignored_cheque_count: parsed.rows.length - rows.length, new_count: rows.length, open_count: 0, changed_count: 0, baseline_only: !!options.firstCheques, baseline_origin: options.firstCheques ? 'FIRST_REPORT' : body.report_kind === 'NORMAL' ? 'EXISTING_BASE' : 'PREVIOUS_REPORT', auto_payment_count: automatic.length, auto_payment_cents: automatic.reduce((sum, item) => sum + item.payment_remaining_cents, 0), missing_count: [...automatic, ...exceptions].filter(item => item.kind === 'MISSING').length, automatic_actions: automatic, exceptions, reconciliation_items: exceptions, bank_options: [dailyBank], unclassified_plans: unclassified, macros: ['FIXO', 'VARIÁVEL'], errors: [], can_commit: exceptions.every(item => item.problem === null) && !unclassified.length };
      if (body.action === 'preview') {
        seen.previews.push(body);
        if (options.deferred) await gate;
        if (options.malformed === 'count') preview.auto_payment_count++;
        if (options.malformed === 'date') preview.report_date = '2026-02-30';
        if (options.malformed === 'partition') rows[0].amount_cents++;
        if (options.malformed === 'automatic-date') automatic[0].paid_on = '2026-10-01';
        if (options.malformed === 'automatic-bank') automatic[0].bank_account_id = dailyUuid(9999);
        if (options.malformed === 'version') preview.daily_report_version = '043';
        return reply({ rows, preview, file_sha256: options.malformed === 'hash' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') });
      }
      seen.commits.push(structuredClone(body));
      if (seen.results.has(body.request_id)) return reply({ ...seen.results.get(body.request_id), idempotent: true });
      if (options.stale) return reply({ code: '40001' }, 409);
      if (!preview.can_commit || body.expected_report_date !== dailyDate || body.previous_financial_revision !== 'revision-58') return reply({ code: '23514' }, 409);
      const paid = Object.values(body.resolution_choices).filter((choice: any) => choice.action === 'PAID') as any[];
      const writeoffs = Object.entries(body.resolution_choices).filter(([, choice]: any) => choice.action === 'WRITE_OFF').map(([key]) => key);
      seen.payments.push(...automatic.map(item => ({ title_id: item.title_id, amount: item.payment_remaining_cents, date: item.paid_on, bank: item.bank_account_id })), ...paid.map(choice => ({ amount: choice.amount_paid_cents, date: choice.paid_on, bank: choice.bank_account_id })));
      seen.writeoffs.push(...writeoffs);
      const result = { daily_report_version: '058', mode: 'daily', report_kind: body.report_kind, report_date: dailyDate, empty_cheques_confirmed: body.empty_cheques_confirmed === true, request_id: body.request_id, report_id: dailyUuid(700), import_id: dailyUuid(701), row_count: rows.length, new_count: rows.length, open_count: 0, changed_count: 0, paid_count: automatic.length + paid.length, written_off_count: writeoffs.length, automatic_paid_count: automatic.length, payment_cents: automatic.reduce((sum, item) => sum + item.payment_remaining_cents, 0) + paid.reduce((sum, choice) => sum + choice.amount_paid_cents, 0), idempotent: false };
      seen.results.set(body.request_id, result);
      if (options.uncertain) return reply({ code: 'XX000' }, 503);
      if (options.invalidCommit) return reply({ ...result, payment_cents: result.payment_cents + 1 });
      return reply(result);
    }
    if (req.method() === 'GET') return reply([]);
    if (url.pathname.startsWith('/rest/v1/rpc/')) return reply({ code: 'PGRST202' }, 404);
    seen.otherWrites.push(url.pathname);
    throw new Error(`Unexpected daily fixture request ${req.method()} ${url.pathname}`);
  });
  await page.goto('/'); await page.getByLabel('Usuário', { exact: true }).fill('PessoaTeste'); await page.getByLabel('Senha', { exact: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Entrar na Central', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sair', exact: false })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true }).click();
  return seen;
}
export async function selectDailyFile(page: Page, content = dailyCsv, cheque = false) {
  if (cheque) await page.getByRole('button', { name: 'Relatório diário de cheques', exact: true }).click();
  await page.getByLabel(cheque ? 'Relatório completo de cheques em aberto' : 'Relatório completo diário de Contas a Pagar', { exact: true }).setInputFiles({ name: cheque ? 'cheques.csv' : 'diario.csv', mimeType: 'text/csv', buffer: Buffer.from(content) });
}
