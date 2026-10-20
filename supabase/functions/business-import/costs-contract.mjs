const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const isUuid = value => typeof value === 'string' && UUID.test(value);
const decimal = value => value === null || typeof value === 'string' && /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value);
const signedQuantity = value => value === null || typeof value === 'string' && /^-?\d{1,10}(?:\.\d{1,6})?$/.test(value);
const amount = value => value === null || Number.isSafeInteger(value);
const count = (value, maximum = 5000) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const normalizeDecimal = value => value === null ? null : value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const nullableUuid = value => value === null || isUuid(value);
const boundedText = value => typeof value === 'string' && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
const sameDecimal = (first, second) => decimal(first) && decimal(second) && normalizeDecimal(first) === normalizeDecimal(second);

export function validCostResolutions(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 5000
    && Object.entries(value).every(([key, line]) => key.length > 0 && key.length <= 500 && key === key.trim() && !/[\u0000-\u001f\u007f]/.test(key) && Number.isSafeInteger(line) && line >= 2 && line <= 5001);
}
export function validCostPreview(preview, rawRows, reference, resolutions) {
  if (!preview || preview.format_version !== 'costs-v1' || preview.reference_date !== reference || preview.row_count !== rawRows.length || !nullableUuid(preview.previous_import_id)
    || typeof preview.can_commit !== 'boolean' || !Array.isArray(preview.rows) || !Array.isArray(preview.conflicts)) return false;
  const groups = new Map();
  for (const row of rawRows) groups.set(row.code, [...(groups.get(row.code) ?? []), row]);
  const needsChoice = group => new Set(group.map(row => JSON.stringify([row.product, normalizeDecimal(row.unit_cost)]))).size > 1;
  const expectedConflicts = [...groups.values()].filter(needsChoice).length;
  const integerFields = ['item_count', 'zero_cost_count', 'missing_weight_count', 'missing_cost_count', 'duplicate_row_count', 'duplicate_code_count', 'conflicting_cost_code_count', 'unresolved_count', 'new_count', 'changed_count', 'unchanged_count', 'removed_count', 'exact_duplicate_count'];
  if (!integerFields.every(key => count(preview[key])) || preview.item_count !== groups.size || preview.rows.length !== groups.size
    || preview.duplicate_row_count !== rawRows.length - groups.size || preview.conflicts.length !== preview.conflicting_cost_code_count || preview.conflicts.length !== expectedConflicts
    || preview.duplicate_code_count !== [...groups.values()].filter(group => group.length > 1).length
    || preview.new_count + preview.changed_count + preview.unchanged_count !== preview.item_count) return false;
  const seen = new Set(), conflicted = new Map();
  const choiceFor = key => Object.hasOwn(resolutions, key) ? resolutions[key] : null;
  for (const item of preview.conflicts) {
    const group = groups.get(item?.code);
    if (!group || !needsChoice(group) || conflicted.has(item.code) || !boundedText(item.product) || !Array.isArray(item.options) || item.options.length !== group.length
      || !item.options.every(option => group.some(row => row.line_number === option?.line_number && sameDecimal(row.unit_cost, option.unit_cost) && sameDecimal(row.weight_kg, option.weight_kg)))
      || new Set(item.options.map(option => option.line_number)).size !== item.options.length
      || !(item.selected_line_number === null || group.some(row => row.line_number === item.selected_line_number))
      || item.selected_line_number !== choiceFor(item.code)) return false;
    conflicted.set(item.code, item);
  }
  if (Object.keys(resolutions).some(key => !conflicted.has(key))) return false;
  for (const item of preview.rows) {
    const group = groups.get(item?.code), conflict = conflicted.get(item?.code);
    if (!group || seen.has(item.code) || !boundedText(item.product) || !decimal(item.unit_cost) || !decimal(item.weight_kg)
      || !Array.isArray(item.source_lines) || item.source_lines.length !== group.length || new Set(item.source_lines).size !== group.length
      || item.source_lines.some(line => !group.some(row => row.line_number === line)) || item.duplicate_count !== group.length - 1
      || typeof item.cost_conflict !== 'boolean' || item.cost_conflict !== !!conflict || typeof item.resolved !== 'boolean'
      || item.selected_line_number !== choiceFor(item.code)) return false;
    const selected = group.find(row => row.line_number === item.line_number);
    if (!selected || Object.hasOwn(resolutions, item.code) && item.line_number !== resolutions[item.code]) return false;
    if (conflict && item.selected_line_number === null) {
      if (item.resolved || item.unit_cost !== null || item.weight_kg !== null) return false;
    } else if (!item.resolved || item.product !== selected.product || !sameDecimal(item.unit_cost, selected.unit_cost)) return false;
    if (!(conflict && item.selected_line_number === null) && !(item.weight_kg === null && item.weight_conflict === true && item.selected_line_number === null) && !sameDecimal(item.weight_kg, selected.weight_kg)) return false;
    seen.add(item.code);
  }
  const unresolved = [...conflicted.values()].filter(item => item.selected_line_number === null).length;
  return preview.unresolved_count === unresolved && preview.can_commit === (unresolved === 0)
    && preview.zero_cost_count === preview.rows.filter(row => normalizeDecimal(row.unit_cost) === '0').length
    && preview.missing_cost_count === preview.rows.filter(row => row.unit_cost === null).length
    && preview.missing_weight_count === preview.rows.filter(row => row.weight_kg === null).length;
}
export function validCostRecalculation(preview, costImportId, month) {
  if (!preview || preview.format_version !== 'costs-recalculation-v1' || preview.month !== month || preview.cost_import_id !== costImportId
    || !nullableUuid(preview.previous_import_id) || typeof preview.can_apply !== 'boolean' || !count(preview.row_count)
    || !Array.isArray(preview.rows) || preview.rows.length !== preview.row_count || typeof preview.revision !== 'string' || !preview.revision.length || preview.revision.length > 256
    || !preview.totals || !['previous_cost_cents', 'new_cost_cents', 'previous_margin_cents', 'new_margin_cents'].every(key => amount(preview.totals[key]))) return false;
  const counters = ['matched_count', 'missing_code_count', 'missing_quantity_count', 'invalid_quantity_count', 'missing_cost_count', 'zero_cost_count', 'missing_components_count'];
  if (!counters.every(key => count(preview[key], preview.row_count))) return false;
  if (preview.source !== null && (!isUuid(preview.source?.import_id) || preview.source.import_id !== preview.previous_import_id || preview.source.month !== month || !boundedText(preview.source.file_name))) return false;
  if (preview.source === null && preview.previous_import_id !== null) return false;
  if (!isUuid(preview.cost_source?.import_id) || preview.cost_source.import_id !== costImportId || !/^\d{4}-\d{2}-\d{2}$/.test(preview.cost_source.reference_date ?? '') || !boundedText(preview.cost_source.file_name)) return false;
  const ids = new Set();
  for (const row of preview.rows) {
    if (!isUuid(row?.id) || ids.has(row.id) || !Number.isSafeInteger(row.line_number) || row.line_number < 2 || row.line_number > 5001
      || !['code', 'product', 'invoice', 'branch'].every(key => boundedText(row[key])) || !signedQuantity(row.quantity) || !decimal(row.unit_cost)
      || !['previous_cost_cents', 'new_cost_cents', 'previous_margin_cents', 'new_margin_cents'].every(key => amount(row[key]))
      || !Array.isArray(row.error_codes) || !row.error_codes.every(code => typeof code === 'string' && /^[A-Z_]{1,100}$/.test(code))) return false;
    ids.add(row.id);
  }
  if (preview.can_apply) {
    if (!preview.source || !preview.row_count || counters.filter(key => key !== 'matched_count').some(key => preview[key] !== 0)
      || preview.rows.some(row => row.error_codes.length || row.new_cost_cents === null || row.new_margin_cents === null || row.quantity === null || Number(row.quantity) === 0 || row.unit_cost === null || Number(row.unit_cost) <= 0)) return false;
    for (const key of ['new_cost_cents', 'new_margin_cents']) if (preview.totals[key] === null || preview.rows.reduce((sum, row) => sum + BigInt(row[key]), 0n) !== BigInt(preview.totals[key])) return false;
  }
  return true;
}
