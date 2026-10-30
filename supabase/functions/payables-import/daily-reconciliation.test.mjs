import test from 'node:test';
import assert from 'node:assert/strict';
import { validDailyRequest, validDailyPreview, validDailyCommit, isDailyCheque } from './daily-reconciliation.mjs';

const TITLE = '10000000-0000-4000-8000-000000000001';
const BANK = '20000000-0000-4000-8000-000000000001';
const REQUEST = '30000000-0000-4000-8000-000000000001';
const REPORT = '40000000-0000-4000-8000-000000000001';
const IMPORT = '50000000-0000-4000-8000-000000000001';
const normal = { entry_number: 'TESTE-001', branch: 'Filial sintética', description: 'Fornecedor sintético',
  due_date: '2026-10-20', amount_cents: 10000, plan: 'PLANO TESTE', bank_account: 'BANCO TESTE', issued_on: null, source_status: 'PENDENTE' };
const cheque = { ...normal, entry_number: 'CHEQUE-001', source_status: 'CHEQUE', cheque_number: '000123' };
const request = extra => ({ action: 'preview', mode: 'daily', daily_report_version: '059', report_kind: 'NORMAL',
  file_name: 'sintetico.csv', file_base64: 'YQ==', mappings: {}, bank_mappings: {}, resolution_choices: {}, ...extra });
const committedRequest = extra => request({ action: 'commit', complete: true, previous_import_id: null,
  previous_financial_revision: '17', expected_report_date: '2026-10-29', request_id: REQUEST, ...extra });
const action = extra => ({ key: `title:${TITLE}`, kind: 'MISSING', line: null, title_id: TITLE, branch: 'Filial sintética',
  entry_number: 'AUSENTE-001', description: 'Obrigação sintética ausente', due_date: '2026-10-20', amount_cents: 15000,
  payment_remaining_cents: 15000, allowed_actions: ['PAID'], selected_action: 'PAID', requires_resolution: false,
  already_written_off: false, problem: null, paid_on: '2026-10-20', bank_account_id: BANK, bank_label: 'BANCO TESTE',
  cheque_number: null, rule: 'DUE_DATE', payment_revision: TITLE, last_import_id: IMPORT, ...extra });
const preview = extra => ({ mode: 'daily', daily_report_version: '059', report_kind: 'NORMAL', report_date: '2026-10-29',
  empty_cheques_confirmed: false,
  previous_import_id: null, financial_revision: '17', rows: [normal], ignored_cheque_count: 0, row_count: 1,
  new_count: 0, open_count: 1, changed_count: 0, baseline_only: false, baseline_origin: 'EXISTING_BASE',
  auto_payment_count: 1, auto_payment_cents: 15000, missing_count: 1, automatic_actions: [action()],
  exceptions: [], reconciliation_items: [], errors: [], bank_options: [{ id: BANK, display_name: 'BRADESCO F2G', account_type: 'BANK' }], can_commit: true, ...extra });
const options = extra => ({ sourceRows: [normal], reportKind: 'NORMAL', resolutionChoices: {}, ...extra });
const result = extra => ({ mode: 'daily', daily_report_version: '059', report_kind: 'NORMAL', report_date: '2026-10-29',
  empty_cheques_confirmed: false,
  request_id: REQUEST, report_id: REPORT, import_id: IMPORT, row_count: 1, new_count: 0, open_count: 1, changed_count: 0,
  paid_count: 1, written_off_count: 0, automatic_paid_count: 1, payment_cents: 15000, idempotent: false, ...extra });

test('daily request requires explicit version, channel, whole-report confirmation and frozen exact protocol', () => {
  assert(validDailyRequest(request())); assert(validDailyRequest(committedRequest()));
  for (const extra of [{ mode: 'forecast' }, { daily_report_version: '043' }, { report_kind: 'ALL' }, { file_name: '../a.csv' },
    { rows: [] }, { user_id: TITLE }, { scope: 'other' }, { full_report: true }, { bank_rules_version: '050' },
    { empty_cheques_confirmed: true }, { empty_cheques_confirmed: false }, { report_kind: 'CHEQUES', empty_cheques_confirmed: 'true' },
    { request_id: REQUEST }, { expected_report_date: '2026-10-29' }]) assert(!validDailyRequest(request(extra)));
  for (const extra of [{ complete: false }, { previous_import_id: undefined }, { previous_financial_revision: '' },
    { request_id: null }, { expected_report_date: '2026-02-30' }, { bank_mappings: { group: 'invented-bank' } },
    { mappings: { PLAN: [] } }]) assert(!validDailyRequest(committedRequest(extra)));
});

test('a zero-cheque position requires explicit channel-specific declaration and exact response echo', () => {
  const emptyRequest = committedRequest({ report_kind: 'CHEQUES', empty_cheques_confirmed: true });
  assert(validDailyRequest(emptyRequest));
  assert(validDailyRequest(request({ report_kind: 'CHEQUES', empty_cheques_confirmed: false })));
  const baseline = preview({ report_kind: 'CHEQUES', rows: [], row_count: 0, new_count: 0, open_count: 0,
    empty_cheques_confirmed: true, baseline_only: true, baseline_origin: 'FIRST_REPORT',
    automatic_actions: [], auto_payment_count: 0, auto_payment_cents: 0, missing_count: 0 });
  const emptyOptions = options({ sourceRows: [], reportKind: 'CHEQUES', emptyChequesConfirmed: true });
  assert(validDailyPreview(baseline, emptyOptions));
  assert(!validDailyPreview(baseline, { ...emptyOptions, emptyChequesConfirmed: false }));
  assert(!validDailyPreview({ ...baseline, empty_cheques_confirmed: false }, emptyOptions));
  assert(!validDailyPreview({ ...baseline, empty_cheques_confirmed: undefined }, emptyOptions));
  assert(!validDailyPreview(baseline, { ...emptyOptions, sourceRows: [cheque] }));
  assert(!validDailyPreview({ ...baseline, report_kind: 'NORMAL' }, { ...emptyOptions, reportKind: 'NORMAL' }));
  const cleared = { ...baseline, baseline_only: false, baseline_origin: 'PREVIOUS_REPORT', missing_count: 1,
    automatic_actions: [action({ paid_on: '2026-10-29', rule: 'IMPORT_DATE', cheque_number: '000009' })],
    auto_payment_count: 1, auto_payment_cents: 15000 };
  assert(validDailyPreview(cleared, emptyOptions));
  assert(!validDailyPreview({ ...cleared, missing_count: 0 }, emptyOptions));
  const completed = result({ report_kind: 'CHEQUES', empty_cheques_confirmed: true,
    row_count: 0, new_count: 0, open_count: 0 });
  assert(validDailyCommit(completed, { sourceRows: [], request: emptyRequest }));
  assert(!validDailyCommit({ ...completed, empty_cheques_confirmed: false }, { sourceRows: [], request: emptyRequest }));
  assert(!validDailyCommit(completed, { sourceRows: [cheque], request: emptyRequest }));
  assert(!validDailyCommit(completed, { sourceRows: [], request: { ...emptyRequest, empty_cheques_confirmed: false } }));
});

test('cheque classification only follows explicit status or explicit cheque number', () => {
  assert(isDailyCheque(cheque)); assert(isDailyCheque({ ...normal, cheque_number: '000001' }));
  assert(isDailyCheque({ ...normal, source_status: ' cheque ' }));
  for (const extra of [{ bank_account: 'CHEQUE' }, { description: 'CHEQUE 000001' }, { source_status: 'CHEQUES' },
    { cheque_number: '' }, { cheque_number: ' ' }]) assert(!isDailyCheque({ ...normal, ...extra }));
});

test('normal preview proves the exact source partition and never silently drops ordinary obligations', () => {
  assert(validDailyPreview(preview(), options()));
  assert(validDailyPreview(preview({ rows: [normal, cheque], row_count: 2, open_count: 2 }), options({ sourceRows: [normal, cheque] })));
  assert(!validDailyPreview(preview({ ignored_cheque_count: 1 }), options({ sourceRows: [normal, cheque] })));
  for (const change of [{ rows: [] }, { rows: [{ ...normal, amount_cents: 1 }] }, { rows: [{ ...normal, due_date: '2026-10-21' }] },
    { rows: [{ ...normal, extra: 'untrusted' }] }, { ignored_cheque_count: 1 }, { row_count: 2 }, { report_kind: 'CHEQUES' },
    { new_count: 1 }, { changed_count: 2 }, { daily_report_version: '057' }]) assert(!validDailyPreview(preview(change), options()));
});

test('automatic actions prove exact date rule, bank, sums and unique canonical identities', () => {
  for (const change of [{ paid_on: '2026-10-21' }, { paid_on: '2026-11-01', due_date: '2026-11-01' },
    { bank_account_id: TITLE }, { bank_account_id: null }, { amount_cents: 1 }, { payment_remaining_cents: 0 },
    { payment_remaining_cents: Number.MAX_SAFE_INTEGER + 1 }, { kind: 'CENT' }, { selected_action: 'WRITE_OFF' },
    { allowed_actions: ['PAID', 'WRITE_OFF'] }, { requires_resolution: true }, { rule: 'IMPORT_DATE' }]) {
    assert(!validDailyPreview(preview({ automatic_actions: [action(change)] }), options()), JSON.stringify(change));
  }
  for (const change of [{ auto_payment_count: 0 }, { auto_payment_cents: 14999 }, { missing_count: 0 },
    { automatic_actions: [action(), action()] }, { bank_options: [{ id: BANK, display_name: 'BRADESCO F2G', account_type: 'BANK' }, { id: BANK, display_name: 'DUPLICADO' }] }]) {
    assert(!validDailyPreview(preview(change), options()));
  }
});

test('separate cheque channel uses import date and first complete report never produces missing settlements', () => {
  const chequePreview = preview({ report_kind: 'CHEQUES', rows: [cheque], baseline_origin: 'PREVIOUS_REPORT',
    automatic_actions: [action({ cheque_number: '000009', paid_on: '2026-10-29', rule: 'IMPORT_DATE' })] });
  const chequeOptions = options({ sourceRows: [cheque], reportKind: 'CHEQUES' });
  assert(validDailyPreview(chequePreview, chequeOptions));
  assert(!validDailyPreview({ ...chequePreview, automatic_actions: [action({ rule: 'IMPORT_DATE' })] }, chequeOptions));
  assert(!validDailyPreview(chequePreview, { ...chequeOptions, sourceRows: [cheque, normal] }));
  const baseline = { ...chequePreview, baseline_only: true, baseline_origin: 'FIRST_REPORT', automatic_actions: [],
    auto_payment_count: 0, auto_payment_cents: 0, missing_count: 0 };
  assert(validDailyPreview(baseline, chequeOptions));
  assert(!validDailyPreview({ ...chequePreview, baseline_only: true, baseline_origin: 'FIRST_REPORT' }, chequeOptions));
  assert(!validDailyPreview({ ...baseline, report_kind: 'NORMAL', rows: [normal] }, options()));
});

test('individual cent confirmation is preserved for present and missing markers without allowing realized payment', () => {
  const source = { ...normal, amount_cents: 1 };
  const item = action({ key: 'row:1', kind: 'CENT', line: 1, title_id: null, branch: source.branch, entry_number: source.entry_number,
    description: source.description, due_date: source.due_date, amount_cents: 1, payment_remaining_cents: 1,
    requires_resolution: true, allowed_actions: ['WRITE_OFF'], selected_action: null, paid_on: null,
    bank_account_id: null, bank_label: null, problem: 'Confirme a baixa individual.' });
  const pending = preview({ rows: [source], auto_payment_count: 0, auto_payment_cents: 0, missing_count: 0,
    automatic_actions: [], exceptions: [item], reconciliation_items: [item], can_commit: false });
  const centOptions = options({ sourceRows: [source] });
  assert(validDailyPreview(pending, centOptions));
  const selected = { ...item, selected_action: 'WRITE_OFF', problem: null };
  const ready = { ...pending, exceptions: [selected], reconciliation_items: [selected], can_commit: true };
  assert(validDailyPreview(ready, { ...centOptions, resolutionChoices: { 'row:1': { action: 'WRITE_OFF', reason: 'Baixa individual confirmada.' } } }));
  assert(!validDailyPreview(ready, centOptions));
  assert(!validDailyPreview({ ...pending, exceptions: [], reconciliation_items: [] }, centOptions));
  const paidOriginal = { ...item, title_id: TITLE, amount_cents: 10000, payment_remaining_cents: 0,
    allowed_actions: [], problem: 'O título já possui pagamento ativo.' };
  assert(validDailyPreview({ ...pending, exceptions: [paidOriginal], reconciliation_items: [paidOriginal] }, centOptions));
  assert(!validDailyPreview({ ...pending, exceptions: [paidOriginal], reconciliation_items: [paidOriginal], can_commit: true }, centOptions));
  const missingCent = { ...item, kind: 'MISSING', line: null, key: `title:${TITLE}`, title_id: TITLE };
  assert(validDailyPreview(preview({ auto_payment_count: 0, auto_payment_cents: 0, automatic_actions: [],
    exceptions: [missingCent], reconciliation_items: [missingCent], can_commit: false }), options()));
});

test('manual date/bank exceptions cannot be omitted or silently approved and paid returns remain blocked', () => {
  const choice = { action: 'PAID', reason: 'Data efetiva e banco conferidos.', paid_on: '2026-10-28', amount_paid_cents: 15000, bank_account_id: BANK };
  const item = action({ requires_resolution: true, selected_action: 'PAID', paid_on: choice.paid_on });
  const ready = preview({ auto_payment_count: 0, auto_payment_cents: 0, automatic_actions: [], exceptions: [item], reconciliation_items: [item] });
  assert(validDailyPreview(ready, options({ resolutionChoices: { [item.key]: choice } })));
  assert(!validDailyPreview(ready, options()));
  assert(!validDailyPreview(ready, options({ resolutionChoices: { [item.key]: { ...choice, amount_paid_cents: 1 } } })));
  const blocked = { ...item, kind: 'REAPPEARED', line: 1, entry_number: normal.entry_number, branch: normal.branch,
    due_date: normal.due_date, allowed_actions: [], selected_action: null, problem: 'Título com pagamento anterior. Confira o histórico.' };
  assert(validDailyPreview(preview({ auto_payment_count: 0, auto_payment_cents: 0, missing_count: 0, automatic_actions: [],
    exceptions: [blocked], reconciliation_items: [blocked], can_commit: false }), options()));
});

test('daily commit result must prove original request, report date, channel and complete counts', () => {
  assert(validDailyCommit(result(), { sourceRows: [normal], request: committedRequest() }));
  assert(validDailyCommit(result({ idempotent: true }), { sourceRows: [normal], request: committedRequest() }));
  for (const change of [{ request_id: REPORT }, { report_date: '2026-10-30' }, { report_kind: 'CHEQUES' }, { import_id: null },
    { report_id: 'other' }, { automatic_paid_count: 2 }, { paid_count: -1 }, { payment_cents: 1.5 }, { row_count: 0 },
    { idempotent: undefined }]) assert(!validDailyCommit(result(change), { sourceRows: [normal], request: committedRequest() }));
});

test('059 numbered cheque payments prove the unique official BANK account and ordinary absence cannot consume a cheque', () => {
  const paidCheque = action({ cheque_number: '000009', paid_on: '2026-10-29', rule: 'IMPORT_DATE' });
  const chequePreview = preview({ report_kind: 'CHEQUES', rows: [cheque], baseline_origin: 'PREVIOUS_REPORT', automatic_actions: [paidCheque] });
  const chequeOptions = options({ sourceRows: [cheque], reportKind: 'CHEQUES' });
  assert(validDailyPreview(chequePreview, chequeOptions));
  for (const bank_options of [
    [{ id: BANK, display_name: 'OUTRO BANCO', account_type: 'BANK' }],
    [{ id: BANK, display_name: 'BRADESCO F2G', account_type: 'CASH' }],
    [{ id: BANK, display_name: 'BRADESCO F2G', account_type: 'BANK' }, { id: TITLE, display_name: 'BRADESCO F2G', account_type: 'BANK' }],
  ]) assert(!validDailyPreview({ ...chequePreview, bank_options }, chequeOptions));
  assert(!validDailyPreview(preview({ automatic_actions: [action({ cheque_number: '000009' })] }), options()));
  assert(validDailyPreview({ ...chequePreview, bank_options: [{ id: BANK, display_name: 'Brádesco  F2G', account_type: 'BANK' }, { id: TITLE, display_name: 'BRADESCO F2G', account_type: 'CASH' }] }, chequeOptions));
});
