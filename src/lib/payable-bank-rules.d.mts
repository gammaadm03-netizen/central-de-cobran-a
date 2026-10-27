export function normalizePaidBankDescription(value: unknown): string;
export function isInternalCashBank(value: unknown): boolean;
export function officialPaidBankName(value: unknown, aliases?: { source: string; official_name: string }[]): string | null;
