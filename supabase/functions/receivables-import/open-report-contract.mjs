import { parseCivilDate } from '../../../src/lib/payables-parser.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const uuid = value => typeof value === 'string' && UUID.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 5000;
const text = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
export function validOpenReportReference(value) {
  try { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && parseCivilDate(value) === value; }
  catch { return false; }
}
function validCounters(value, fullReport) {
  return ['retired_count', 'retired_worked_count', 'retired_unworked_count', 'reappeared_count'].every(key => count(value[key]))
    && value.retired_count === value.retired_worked_count + value.retired_unworked_count && (fullReport || value.retired_count === 0);
}
export function validOpenReportPreview(preview, { fullReport, referenceDate, rowCount }) {
  if (preview?.format_version !== 'receivables-open-report-v1' || preview.full_report !== fullReport || preview.reference_date !== referenceDate
    || !validOpenReportReference(preview.reference_date) || !validCounters(preview, fullReport)
    || preview.reappeared_count > rowCount || !(preview.previous_import_id === null || uuid(preview.previous_import_id))
    || !Array.isArray(preview.retirement_items) || preview.retirement_items.length !== preview.retired_count) return false;
  const present = new Set(preview.rows.map(row => row.title_id).filter(Boolean)), seen = new Set(); let worked = 0;
  for (const item of preview.retirement_items) {
    if (!uuid(item?.title_id) || seen.has(item.title_id) || present.has(item.title_id)
      || !text(item.client_name, 1500) || !text(item.document, 150) || !text(item.branch, 150)
      || !validOpenReportReference(item.due_date) || !Number.isSafeInteger(item.amount_cents) || item.amount_cents < 0
      || !(item.collector_id === null || uuid(item.collector_id)) || typeof item.worked !== 'boolean') return false;
    seen.add(item.title_id); if (item.worked) worked++;
  }
  return worked === preview.retired_worked_count;
}
export function validOpenReportCommit(result, { fullReport, referenceDate, requestId, rowCount }) {
  return result?.format_version === 'receivables-open-report-v1' && result.full_report === fullReport && result.reference_date === referenceDate
    && validOpenReportReference(result.reference_date) && result.row_count === rowCount && uuid(result.import_id)
    && uuid(result.request_id) && result.request_id.toLowerCase() === requestId.toLowerCase() && typeof result.idempotent === 'boolean'
    && validCounters(result, fullReport) && result.reappeared_count <= rowCount;
}
