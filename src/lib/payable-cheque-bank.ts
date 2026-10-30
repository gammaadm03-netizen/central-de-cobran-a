import { normalizePaidBankDescription } from './payable-bank-rules.mjs';

export const hasPayableChequeNumber = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

// Account lists are supplied by the authorized payment RPC. Never infer an ID
// from a label or choose arbitrarily when the official register is ambiguous.
export function payableChequePaymentBank<T extends { id: string; display_name: string; account_type?: string }>(accounts: T[]): T | null {
  const matches = accounts.filter(account => account.account_type === 'BANK' && normalizePaidBankDescription(account.display_name) === 'BRADESCO F2G');
  return matches.length === 1 ? matches[0] : null;
}
