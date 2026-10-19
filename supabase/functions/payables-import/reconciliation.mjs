const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const ROW_KEY = /^row:([1-9]\d{0,3})$/;
const ACTIONS = new Set(['WRITE_OFF', 'PAID', 'REOPEN']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeAmount = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const identity = value => String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
export function validReconciliationDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2199-12-31') return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validResolutionKey(value, rowCount = 5000) {
  if (typeof value !== 'string') return false;
  const row = ROW_KEY.exec(value);
  return row ? Number(row[1]) <= rowCount : value.startsWith('title:') && UUID.test(value.slice(6));
}
export function validResolutionChoices(value, rowCount = 5000) {
  if (!object(value) || Object.keys(value).length > 10000) return false;
  return Object.entries(value).every(([key, choice]) => {
    if (!validResolutionKey(key, rowCount) || !object(choice) || !ACTIONS.has(choice.action)
      || !text(choice.reason, 1000) || choice.reason !== choice.reason.trim()) return false;
    const fields = choice.action === 'PAID'
      ? ['action', 'reason', 'paid_on', 'amount_paid_cents', 'bank_account_id'] : ['action', 'reason'];
    if (Object.keys(choice).some(field => !fields.includes(field))) return false;
    return choice.action !== 'PAID' || validReconciliationDate(choice.paid_on)
      && Number.isSafeInteger(choice.amount_paid_cents) && choice.amount_paid_cents > 0 && typeof choice.bank_account_id === 'string' && UUID.test(choice.bank_account_id);
  });
}
export function validReconciliationPreview(preview, { rowCount, mode, fullReport, sourceRows, resolutionChoices = {} } = {}) {
  if (!object(preview) || preview.reconciliation_version !== '043' || preview.row_count !== rowCount || preview.mode !== mode
    || !text(preview.financial_revision, 256) || preview.financial_revision !== preview.financial_revision.trim()
    || typeof preview.can_commit !== 'boolean' || !Array.isArray(preview.reconciliation_items) || preview.reconciliation_items.length > 15000
    || !Array.isArray(preview.resolution_errors) || preview.resolution_errors.length > 15000
    || preview.can_commit && preview.resolution_errors.length !== 0
    || mode === 'forecast' && preview.full_report !== fullReport) return false;
  const keys = new Set();
  for (const item of preview.reconciliation_items) {
    if (!object(item) || !validResolutionKey(item.key, rowCount) || keys.has(item.key)
      || !['CENT', 'MISSING', 'REAPPEARED'].includes(item.kind)
      || !(item.line === null || Number.isSafeInteger(item.line) && item.line >= 1 && item.line <= rowCount)
      || !(item.title_id === null || typeof item.title_id === 'string' && UUID.test(item.title_id))
      || !text(item.branch, 300) || !text(item.entry_number, 300) || typeof item.description !== 'string' || item.description.length > 1500
      || !(validReconciliationDate(item.due_date) || !preview.can_commit && item.title_id === null && item.due_date === null)
      || !(safeAmount(item.amount_cents) || !preview.can_commit && item.title_id === null && item.amount_cents === null)
      || !Array.isArray(item.allowed_actions) || item.allowed_actions.length > 3 || new Set(item.allowed_actions).size !== item.allowed_actions.length
      || item.allowed_actions.some(action => !ACTIONS.has(action))
      || !(item.selected_action === null || item.allowed_actions.includes(item.selected_action))
      || typeof item.requires_resolution !== 'boolean' || !(item.problem === null || typeof item.problem === 'string' && item.problem.length <= 2000)
      || item.kind === 'CENT' && item.allowed_actions.some(action => action !== 'WRITE_OFF')) return false;
    if (preview.can_commit && item.requires_resolution && !item.selected_action) return false;
    if (item.selected_action !== (resolutionChoices[item.key]?.action ?? null)) return false;
    if (preview.can_commit && item.problem) return false;
    if (item.kind === 'CENT') {
      if (item.line === null || item.key !== `row:${item.line}`) return false;
    } else if (item.title_id === null || item.key !== `title:${item.title_id}` || mode !== 'forecast'
      || item.kind === 'MISSING' && (!fullReport || item.line !== null)
      || item.kind === 'REAPPEARED' && item.line === null) return false;
    if (Array.isArray(sourceRows) && item.line !== null) {
      const row = sourceRows[item.line - 1];
      if (!row || identity(item.branch) !== identity(row.branch) || identity(item.entry_number) !== identity(row.entry_number)
        || item.kind === 'CENT' && (mode === 'payments' ? row.amount_paid_cents : row.amount_cents) !== 1) return false;
    }
    keys.add(item.key);
  }
  if (Array.isArray(sourceRows) && sourceRows.some((row, index) => (mode === 'payments' ? row.amount_paid_cents : row.amount_cents) === 1
    && !preview.reconciliation_items.some(item => item.key === `row:${index + 1}` && item.kind === 'CENT'))) return false;
  if (preview.can_commit && Object.keys(resolutionChoices).some(key => !keys.has(key))) return false;
  return true;
}
