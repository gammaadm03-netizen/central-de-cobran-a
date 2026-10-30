import { validReconciliationDate, validResolutionChoices } from './reconciliation.mjs';

const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, empty = false) => typeof value === 'string' && (empty || value.length > 0)
  && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => value.trim().replace(/\s+/g, ' ').toUpperCase();
const businessKey = row => JSON.stringify([identity(row.branch), identity(row.entry_number)]);
function canonicalSourceKey(value) {
  try {
    const parts = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 2 && parts.every(part => text(part, 150))
      && parts.every(part => identity(part) === part) ? JSON.stringify(parts) : null;
  } catch { return null; }
}
const same = (first, second) => first === second || Array.isArray(first) && Array.isArray(second)
  && first.length === second.length && first.every((item, index) => same(item, second[index]))
  || object(first) && object(second) && Object.keys(first).length === Object.keys(second).length
  && Object.keys(first).every(key => Object.hasOwn(second, key) && same(first[key], second[key]));
const sourceRow = row => object(row) && text(row.entry_number, 150) && text(row.branch, 150)
  && text(row.description, 1500, true) && text(row.plan, 300, true) && text(row.bank_account, 300, true)
  && text(row.source_status, 150, true) && count(row.amount_cents)
  && validReconciliationDate(row.due_date) && (row.issued_on === null || validReconciliationDate(row.issued_on))
  && (row.cheque_number === undefined || row.cheque_number === null || text(row.cheque_number, 150, true));

export const OPEN_STATUS_REPORT_VERSION = '061';
export function validStatusResolutionChoices(value, rowCount = 5000) {
  return validResolutionChoices(value, rowCount)
    && Object.values(value).every(choice => choice.action === 'WRITE_OFF');
}
export function validRoundingAdjustments(value) {
  return Array.isArray(value) && value.length <= 5000 && new Set(value.map(item => item?.line)).size === value.length
    && value.every(item => object(item) && Object.keys(item).length === 3
      && Number.isSafeInteger(item.line) && item.line >= 2 && item.line <= 5001
      && text(item.original_amount, 300) && count(item.amount_cents));
}
export function validOpenStatusRequest(body) {
  const fields = ['action', 'mode', 'status_report_version', 'report_kind', 'file_name', 'file_base64', 'mappings',
    'resolution_choices', 'complete', 'previous_import_id', 'previous_financial_revision', 'expected_report_date', 'request_id', 'empty_report_confirmed'];
  if (!object(body) || Object.keys(body).some(key => !fields.includes(key)) || body.mode !== 'open_status'
    || body.status_report_version !== OPEN_STATUS_REPORT_VERSION || body.report_kind !== 'ALL'
    || !['preview', 'commit'].includes(body.action) || !text(body.file_name, 250) || /[/\\]/.test(body.file_name)
    || Object.hasOwn(body, 'empty_report_confirmed') && typeof body.empty_report_confirmed !== 'boolean'
    || !object(body.mappings ?? {}) || Object.keys(body.mappings ?? {}).length > 5000
    || Object.entries(body.mappings ?? {}).some(([key, value]) => !text(key, 300) || !text(value, 100))
    || !validStatusResolutionChoices(body.resolution_choices ?? {})) return false;
  if (body.action === 'preview') return !['complete', 'previous_import_id', 'previous_financial_revision', 'expected_report_date', 'request_id']
    .some(key => Object.hasOwn(body, key));
  return body.complete === true && (body.previous_import_id === null || uuid(body.previous_import_id))
    && text(body.previous_financial_revision, 256) && validReconciliationDate(body.expected_report_date) && uuid(body.request_id);
}

export function validOpenStatusPreview(preview, { sourceRows, resolutionChoices, roundingAdjustments, emptyReportConfirmed = false } = {}) {
  if (!object(preview) || !Array.isArray(sourceRows) || sourceRows.length > 5000 || !sourceRows.every(sourceRow)
    || sourceRows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n) > BigInt(Number.MAX_SAFE_INTEGER)
    || preview.mode !== 'open_status' || preview.status_report_version !== OPEN_STATUS_REPORT_VERSION || preview.status_only !== true
    || preview.report_kind !== 'ALL' || !validReconciliationDate(preview.report_date) || !text(preview.financial_revision, 256)
    || !(preview.previous_import_id === null || uuid(preview.previous_import_id))
    || typeof emptyReportConfirmed !== 'boolean' || preview.empty_report_confirmed !== emptyReportConfirmed
    || (sourceRows.length === 0) !== emptyReportConfirmed || !same(preview.rows, sourceRows)
    || preview.row_count !== sourceRows.length || typeof preview.can_commit !== 'boolean' || typeof preview.baseline_only !== 'boolean'
    || !['FIRST_REPORT', 'PREVIOUS_REPORT'].includes(preview.baseline_origin)
    || preview.baseline_only !== (preview.baseline_origin === 'FIRST_REPORT')
    || !['new_count', 'open_count', 'changed_count', 'marked_paid_count', 'marked_paid_cents', 'reopened_count'].every(key => count(preview[key]))
    || preview.new_count + preview.open_count !== sourceRows.length || preview.changed_count > preview.open_count || preview.reopened_count > preview.open_count
    || ['payment_cents', 'payments_created', 'auto_payment_count', 'auto_payment_cents'].some(key => Object.hasOwn(preview, key) && preview[key] !== 0)
    || !validRoundingAdjustments(preview.rounding_adjustments)
    || roundingAdjustments !== undefined && (!validRoundingAdjustments(roundingAdjustments) || !same(preview.rounding_adjustments, roundingAdjustments))
    || !Array.isArray(preview.status_actions) || preview.status_actions.length > 15000
    || !Array.isArray(preview.exceptions) || preview.exceptions.length > 10000
    || !Array.isArray(preview.errors) || preview.errors.length > 100
    || preview.errors.some(item => !object(item) || !count(item.line) || item.line > 5001
      || !text(item.column, 300) || !text(item.problem, 2000) || !text(item.correction, 2000))
    || preview.can_commit && preview.errors.length > 0
    || !Array.isArray(preview.unmapped_plans) || preview.unmapped_plans.length > 5000
    || preview.unmapped_plans.some(item => !object(item) || !text(item.plan, 300) || !count(item.count) || item.count < 1 || !count(item.total_cents))
    || new Set(preview.unmapped_plans.map(item => item.plan)).size !== preview.unmapped_plans.length
    || !Array.isArray(preview.macro_options) || preview.macro_options.length > 5000
    || preview.macro_options.some(macro => !text(macro, 100)) || new Set(preview.macro_options).size !== preview.macro_options.length) return false;
  const titles = new Set(), sourceKeys = new Set(), incoming = new Map(sourceRows.map(row => [businessKey(row), row]));
  let paid = 0, reopened = 0, nominalCents = 0n;
  for (const item of preview.status_actions) {
    if (!object(item) || !['PAID', 'REOPEN'].includes(item.kind) || !uuid(item.title_id) || titles.has(item.title_id.toLowerCase())
      || !text(item.source_key, 1000) || !canonicalSourceKey(item.source_key) || sourceKeys.has(canonicalSourceKey(item.source_key)) || !count(item.amount_cents) || item.amount_cents === 1
      || ['paid_on', 'bank_account_id', 'payment_id'].some(key => Object.hasOwn(item, key) && item[key] !== null)
      || Object.hasOwn(item, 'payment_cents') && item.payment_cents !== 0) return false;
    const key = canonicalSourceKey(item.source_key);
    if (item.kind === 'PAID' && incoming.has(key)
      || item.kind === 'REOPEN' && incoming.get(key)?.amount_cents !== item.amount_cents) return false;
    titles.add(item.title_id.toLowerCase()); sourceKeys.add(key);
    if (item.kind === 'PAID') { paid++; nominalCents += BigInt(item.amount_cents); } else reopened++;
  }
  if (paid !== preview.marked_paid_count || reopened !== preview.reopened_count || nominalCents !== BigInt(preview.marked_paid_cents)
    || preview.baseline_only && paid > 0) return false;
  const keys = new Set(), centRows = new Set();
  for (const item of preview.exceptions) {
    if (!object(item) || item.kind !== 'CENT' || item.amount_cents !== 1
      || !(item.title_id === null || uuid(item.title_id)) || keys.has(item.key)
      || !(item.line === null || Number.isSafeInteger(item.line) && item.line >= 1 && item.line <= sourceRows.length)
      || !text(item.branch, 300) || !text(item.entry_number, 300) || !text(item.description, 1500, true)
      || !validReconciliationDate(item.due_date) || typeof item.requires_resolution !== 'boolean'
      || !Array.isArray(item.allowed_actions) || item.allowed_actions.length > 1 || item.allowed_actions.some(action => action !== 'WRITE_OFF')
      || !(item.selected_action === null || item.selected_action === 'WRITE_OFF' && item.allowed_actions.includes('WRITE_OFF'))
      || !(item.problem === null || text(item.problem, 2000))
      || ['paid_on', 'bank_account_id', 'bank_label', 'payment_id'].some(key => Object.hasOwn(item, key) && item[key] !== null)
      || Object.hasOwn(item, 'payment_remaining_cents') && item.payment_remaining_cents !== 0) return false;
    if (item.line === null) {
      if (!uuid(item.title_id) || item.key !== `title:${item.title_id}`) return false;
    } else {
      const row = sourceRows[item.line - 1];
      if (item.key !== `row:${item.line}` || row.amount_cents !== 1 || row.branch !== item.branch
        || row.entry_number !== item.entry_number || row.due_date !== item.due_date || centRows.has(item.line)) return false;
      centRows.add(item.line);
    }
    if (resolutionChoices !== undefined && item.selected_action !== (resolutionChoices[item.key]?.action ?? null)) return false;
    if (preview.can_commit && (item.problem !== null || item.requires_resolution && item.selected_action !== 'WRITE_OFF')) return false;
    keys.add(item.key);
  }
  if (sourceRows.some((row, index) => row.amount_cents === 1 && !centRows.has(index + 1))
    || resolutionChoices !== undefined && (!validStatusResolutionChoices(resolutionChoices, sourceRows.length)
      || Object.keys(resolutionChoices).some(key => !keys.has(key)))) return false;
  return true;
}

export function validOpenStatusCommit(result, { sourceRows, request, roundingAdjustments } = {}) {
  if (!object(result) || !Array.isArray(sourceRows) || !object(request) || result.mode !== 'open_status'
    || result.status_report_version !== OPEN_STATUS_REPORT_VERSION || result.status_only !== true || result.report_kind !== 'ALL'
    || result.report_date !== request.expected_report_date || result.request_id !== request.request_id
    || result.empty_report_confirmed !== (request.empty_report_confirmed ?? false)
    || (sourceRows.length === 0) !== (request.empty_report_confirmed === true)
    || !uuid(result.report_id) || !uuid(result.import_id) || typeof result.idempotent !== 'boolean' || typeof result.baseline_only !== 'boolean'
    || result.row_count !== sourceRows.length || result.paid_count !== 0 || result.payment_cents !== 0 || result.payments_created !== 0
    || !['new_count', 'open_count', 'updated_count', 'marked_paid_count', 'marked_paid_cents', 'reopened_count', 'written_off_count'].every(key => count(result[key]))
    || !validRoundingAdjustments(result.rounding_adjustments)
    || roundingAdjustments !== undefined && !same(result.rounding_adjustments, roundingAdjustments)) return false;
  return result.new_count + result.open_count === result.row_count && result.updated_count <= result.open_count
    && result.reopened_count <= result.open_count
    && (!result.baseline_only || result.marked_paid_count === 0)
    && result.written_off_count <= Object.keys(request.resolution_choices ?? {}).length;
}
