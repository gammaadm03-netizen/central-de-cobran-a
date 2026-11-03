import { validOpenReportCommit, validOpenReportReference } from './open-report-contract.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

/** A missing committed row is not proof that the original transaction stopped. */
export function validOpenReportStatus(value, { requestId, fileSha256, fullReport, referenceDate, rowCount }) {
  if (!object(value) || !UUID.test(requestId) || !/^[a-f0-9]{64}$/.test(fileSha256)
    || typeof fullReport !== 'boolean' || !validOpenReportReference(referenceDate)
    || !Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > 5000
    || value.format_version !== 'receivables-open-report-status-v1'
    || typeof value.request_id !== 'string' || value.request_id.toLowerCase() !== requestId.toLowerCase() || value.source_sha256 !== fileSha256
    || value.full_report !== fullReport || value.reference_date !== referenceDate || value.row_count !== rowCount) return false;
  if (value.status === 'UNCONFIRMED') return value.result === null;
  if (value.status !== 'COMPLETED' || !validOpenReportCommit(value.result, { fullReport, referenceDate, requestId, rowCount })) return false;
  const result = value.result;
  return result.mode === 'open' && result.collector_assignment_version === '030'
    && count(result.assigned_title_count) && count(result.assigned_customer_count)
    && result.assigned_customer_count <= result.assigned_title_count
    && (result.return_approval_version === undefined || result.return_approval_version === '057'
      && count(result.returned_count) && result.returned_count <= rowCount);
}
