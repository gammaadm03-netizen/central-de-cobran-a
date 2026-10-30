// Historical 059 contract retained only for testing the published legacy RPCs.
// Current production HTTP requests use the strict 060 ALL contract.
import { normalizePaidBankDescription } from '../../src/lib/payable-bank-rules.mjs';
import { validReconciliationDate, validResolutionChoices, validResolutionKey } from '../../supabase/functions/payables-import/reconciliation.mjs';

const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const mapping = (value, max, keyMax, validValue) => object(value) && Object.keys(value).length <= max
  && Object.entries(value).every(([key, item]) => text(key, keyMax) && validValue(item));

export const DAILY_REPORT_VERSION = '059';
export function isDailyCheque(row) {
  return String(row.source_status ?? '').trim().toUpperCase() === 'CHEQUE'
    || typeof row.cheque_number === 'string' && row.cheque_number.trim() !== '';
}
export function dailyReportSourceRows(rows, kind) {
  return kind === 'CHEQUES' ? rows.filter(isDailyCheque) : rows;
}
export function validDailyRequest(body) {
  const fields = ['action', 'mode', 'daily_report_version', 'report_kind', 'file_name', 'file_base64', 'mappings', 'bank_mappings',
    'resolution_choices', 'complete', 'previous_import_id', 'previous_financial_revision', 'expected_report_date', 'request_id', 'empty_cheques_confirmed'];
  if (!object(body) || Object.keys(body).some(key => !fields.includes(key)) || body.mode !== 'daily'
    || body.daily_report_version !== DAILY_REPORT_VERSION || !['NORMAL', 'CHEQUES'].includes(body.report_kind)
    || !['preview', 'commit'].includes(body.action) || !text(body.file_name, 250) || /[/\\]/.test(body.file_name)
    || Object.hasOwn(body, 'empty_cheques_confirmed') && (body.report_kind !== 'CHEQUES' || typeof body.empty_cheques_confirmed !== 'boolean')
    || !mapping(body.mappings ?? {}, 5000, 300, value => text(value, 100))
    || !mapping(body.bank_mappings ?? {}, 10000, 1000, uuid)
    || !validResolutionChoices(body.resolution_choices ?? {})) return false;
  if (body.action === 'preview') return !['complete', 'previous_import_id', 'previous_financial_revision', 'expected_report_date', 'request_id']
    .some(key => Object.hasOwn(body, key));
  return body.complete === true && (body.previous_import_id === null || uuid(body.previous_import_id))
    && text(body.previous_financial_revision, 256) && validReconciliationDate(body.expected_report_date) && uuid(body.request_id);
}

function sameSourceRow(first, second) {
  return object(first) && Object.keys(first).length === Object.keys(second).length
    && Object.keys(second).every(key => Object.hasOwn(first, key) && first[key] === second[key]);
}

export function validDailyPreview(preview, { sourceRows, reportKind, resolutionChoices = {}, emptyChequesConfirmed = false } = {}) {
  if (!object(preview) || !Array.isArray(sourceRows) || preview.mode !== 'daily'
    || preview.daily_report_version !== DAILY_REPORT_VERSION || preview.report_kind !== reportKind
    || !validReconciliationDate(preview.report_date) || !text(preview.financial_revision, 256)
    || !(preview.previous_import_id === null || uuid(preview.previous_import_id))
    || typeof preview.can_commit !== 'boolean' || typeof preview.baseline_only !== 'boolean'
    || preview.empty_cheques_confirmed !== emptyChequesConfirmed || typeof emptyChequesConfirmed !== 'boolean'
    || emptyChequesConfirmed && (reportKind !== 'CHEQUES' || sourceRows.length !== 0)) return false;
  const filtered = dailyReportSourceRows(sourceRows, reportKind);
  if (!filtered.length && !emptyChequesConfirmed || reportKind === 'CHEQUES' && filtered.length !== sourceRows.length
    || !Array.isArray(preview.rows) || preview.rows.length !== filtered.length
    || preview.rows.some((row, index) => !sameSourceRow(row, filtered[index]))
    || preview.row_count !== filtered.length || preview.ignored_cheque_count !== sourceRows.length - filtered.length
    || !['new_count', 'open_count', 'changed_count', 'missing_count', 'auto_payment_count', 'auto_payment_cents']
      .every(key => count(preview[key]))
    || preview.new_count + preview.open_count !== preview.row_count || preview.changed_count > preview.open_count
    || !['exceptions', 'automatic_actions', 'reconciliation_items', 'errors', 'bank_options'].every(key => Array.isArray(preview[key]) && preview[key].length <= 15000)
    || !['EXISTING_BASE', 'PREVIOUS_REPORT', 'FIRST_REPORT'].includes(preview.baseline_origin)
    || preview.can_commit && preview.errors.length > 0) return false;
  if (preview.bank_options.some(bank => !object(bank) || !uuid(bank.id) || !text(bank.display_name, 200))) return false;
  if (new Set(preview.bank_options.map(bank => bank.id)).size !== preview.bank_options.length) return false;
  if (JSON.stringify(preview.exceptions) !== JSON.stringify(preview.reconciliation_items)) return false;
  if (preview.errors.some(error => !object(error) || !count(error.line) || error.line > 5001
    || !text(error.column, 300) || !text(error.problem, 2000) || !text(error.correction, 2000))) return false;
  const keys = new Set(), titleIds = new Set(), banks = new Set(preview.bank_options.map(bank => bank.id));
  let automaticCents = 0n, missing = 0;
  for (const [items, automatic] of [[preview.exceptions, false], [preview.automatic_actions, true]]) {
    for (const item of items) {
      if (!object(item) || !validResolutionKey(item.key, filtered.length) || keys.has(item.key)
        || !['CENT', 'MISSING', 'REAPPEARED'].includes(item.kind)
        || !(item.line === null || Number.isSafeInteger(item.line) && item.line >= 1 && item.line <= filtered.length)
        || !(item.title_id === null && item.kind === 'CENT' || uuid(item.title_id))
        || !text(item.branch, 300) || !text(item.entry_number, 300)
        || typeof item.description !== 'string' || item.description.length > 1500
        || !validReconciliationDate(item.due_date) || !count(item.amount_cents) || !count(item.payment_remaining_cents)
        || !Array.isArray(item.allowed_actions) || item.allowed_actions.length > 3
        || new Set(item.allowed_actions).size !== item.allowed_actions.length
        || item.allowed_actions.some(action => !['PAID', 'WRITE_OFF', 'REOPEN'].includes(action))
        || !(item.selected_action === null || item.allowed_actions.includes(item.selected_action))
        || typeof item.requires_resolution !== 'boolean'
        || !(item.problem === null || text(item.problem, 2000))
        || !(item.paid_on === null || validReconciliationDate(item.paid_on))
        || !(item.bank_account_id === null || uuid(item.bank_account_id))
        || !(item.bank_label === null || text(item.bank_label, 200))
        || !(item.cheque_number === null || typeof item.cheque_number === 'string' && item.cheque_number.length <= 150)
        || item.rule !== (reportKind === 'NORMAL' ? 'DUE_DATE' : 'IMPORT_DATE')) return false;
      if (item.title_id !== null && titleIds.has(item.title_id)) return false;
      if (item.kind === 'MISSING') {
        if (item.line !== null || !uuid(item.title_id) || item.key !== `title:${item.title_id}`) return false;
        if (reportKind === 'NORMAL' && typeof item.cheque_number === 'string' && item.cheque_number.trim()) return false;
        missing++;
      } else if (item.line === null) return false;
      if (item.kind === 'CENT' && (item.key !== `row:${item.line}` || filtered[item.line - 1].amount_cents !== 1
        || !(item.allowed_actions.length === 1 && item.allowed_actions[0] === 'WRITE_OFF'
          || !preview.can_commit && item.allowed_actions.length === 0 && item.problem !== null))) return false;
      if (item.kind === 'REAPPEARED' && item.key !== `title:${item.title_id}`) return false;
      if (item.line !== null) {
        const row = filtered[item.line - 1];
        if (item.branch !== row.branch || item.entry_number !== row.entry_number || item.due_date !== row.due_date) return false;
      }
      if (automatic) {
        if (item.kind !== 'MISSING' || item.amount_cents === 1 || item.payment_remaining_cents <= 0
          || item.requires_resolution || item.selected_action !== 'PAID' || item.allowed_actions.length !== 1 || item.allowed_actions[0] !== 'PAID'
          || item.problem !== null || !banks.has(item.bank_account_id) || item.bank_label === null
          || item.paid_on !== (reportKind === 'NORMAL' ? item.due_date : preview.report_date)
          || item.paid_on > preview.report_date) return false;
        automaticCents += BigInt(item.payment_remaining_cents);
      } else {
        const choice = resolutionChoices[item.key];
        if (item.requires_resolution !== true || item.selected_action !== (choice?.action ?? null)
          || item.kind === 'MISSING' && (item.amount_cents === 1
            ? item.allowed_actions.length !== 1 || item.allowed_actions[0] !== 'WRITE_OFF'
            : item.allowed_actions.length !== 1 || item.allowed_actions[0] !== 'PAID')) return false;
        if (preview.can_commit && (item.problem !== null || !choice
          || choice.action === 'PAID' && (choice.paid_on !== item.paid_on || choice.amount_paid_cents !== item.payment_remaining_cents
            || choice.bank_account_id !== item.bank_account_id || !banks.has(item.bank_account_id) || item.paid_on > preview.report_date))) return false;
      }
      if (item.amount_cents !== 1 && typeof item.cheque_number === 'string' && item.cheque_number.trim()
        && item.selected_action === 'PAID' && item.problem === null) {
        const official = preview.bank_options.filter(bank => bank.account_type === 'BANK' && normalizePaidBankDescription(bank.display_name) === 'BRADESCO F2G');
        if (official.length !== 1 || official[0].id !== item.bank_account_id) return false;
      }
      keys.add(item.key);
      if (item.title_id !== null) titleIds.add(item.title_id);
    }
  }
  if (preview.auto_payment_count !== preview.automatic_actions.length || automaticCents !== BigInt(preview.auto_payment_cents)
    || missing !== preview.missing_count || preview.baseline_only && (missing > 0 || reportKind !== 'CHEQUES')
    || preview.baseline_only !== (preview.baseline_origin === 'FIRST_REPORT')
    || preview.can_commit && Object.keys(resolutionChoices).some(key => !keys.has(key))) return false;
  for (let index = 0; index < filtered.length; index++) if (filtered[index].amount_cents === 1
    && !preview.exceptions.some(item => item.kind === 'CENT' && item.line === index + 1)) return false;
  return true;
}

export function validDailyCommit(result, { sourceRows, request } = {}) {
  if (!object(result) || !Array.isArray(sourceRows) || !object(request) || result.mode !== 'daily'
    || result.daily_report_version !== DAILY_REPORT_VERSION || result.report_kind !== request.report_kind
    || result.report_date !== request.expected_report_date || result.request_id !== request.request_id
    || result.empty_cheques_confirmed !== (request.empty_cheques_confirmed ?? false)
    || Object.hasOwn(request, 'empty_cheques_confirmed') && (request.report_kind !== 'CHEQUES' || typeof request.empty_cheques_confirmed !== 'boolean')
    || !uuid(result.report_id) || !uuid(result.import_id) || typeof result.idempotent !== 'boolean'
    || !['row_count', 'new_count', 'open_count', 'changed_count', 'paid_count', 'written_off_count', 'automatic_paid_count', 'payment_cents']
      .every(key => count(result[key]))) return false;
  const filtered = dailyReportSourceRows(sourceRows, request.report_kind);
  return (filtered.length > 0 && request.empty_cheques_confirmed !== true
      || request.report_kind === 'CHEQUES' && request.empty_cheques_confirmed === true && sourceRows.length === 0)
    && result.row_count === filtered.length
    && result.new_count + result.open_count === result.row_count && result.changed_count <= result.open_count
    && result.automatic_paid_count <= result.paid_count;
}
