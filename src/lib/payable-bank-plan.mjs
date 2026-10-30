import { isInternalCashBank } from './payable-bank-rules.mjs';
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;

// Keep the IDs returned by the official preview in the next preview and frozen
// commit. A renamed or replaced account must not silently change that choice.
export function resolvePaidBankMappings(rows, mappings = {}) {
  const result = { ...mappings }, resolved = new Map();
  let changed = false;
  for (const row of rows) {
    if (row.amount_paid_cents === 1 || row.payment_bank_rule === 'CHEQUE_F2G' || isInternalCashBank(row.paid_bank) || row.bank_account_id === null) continue;
    if (typeof row.bank_mapping_key !== 'string' || !row.bank_mapping_key || row.bank_mapping_key.length > 1000
      || typeof row.bank_account_id !== 'string' || !uuid.test(row.bank_account_id)) throw new Error('invalid-bank-plan');
    const previous = resolved.get(row.bank_mapping_key);
    if (previous !== undefined && previous !== row.bank_account_id) throw new Error('conflicting-bank-plan');
    resolved.set(row.bank_mapping_key, row.bank_account_id);
    if (Object.hasOwn(result, row.bank_mapping_key)) {
      if (result[row.bank_mapping_key] !== row.bank_account_id) throw new Error('conflicting-bank-plan');
    } else { result[row.bank_mapping_key] = row.bank_account_id; changed = true; }
  }
  return { mappings: result, changed };
}
