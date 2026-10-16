import type { BankPosition, CashPosition, StockPosition } from '../components/Treasury';

export const ASSETS_FORMULA = '(Caixa + Contas a Receber + Estoque − Impostos do mês passado − Faturamento geral × 14% − Pagamento de mercadoria − Parcelamentos) ÷ 1.000.000';
export const FORMULA_VERSION = '2026-10-sem-m49';
export interface DirectorReport {
  as_of_date: string;
  inputs: { id: string; reference_date: string; created_at: string; observation: string } | null;
  indicators: Record<string, unknown>;
  cash: CashPosition;
  stock: StockPosition;
  missing_sources: string[];
  complete: boolean;
  formula_version: string;
}
export function reportAmount(values: Record<string, unknown> | undefined, key: string): number | null {
  const value = values?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
// Keep every decimal supplied by PostgreSQL. Do not round the 14% deduction
// to cents or convert the result to a JavaScript floating-point calculation.
export function exactMillions(value: unknown): string | null {
  if (typeof value !== 'string' || !/^-?\d{1,10}(?:\.\d{1,40})?$/.test(value)) return null;
  const canonical = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return /^-?\d{1,10}(?:\.\d{1,10})?$/.test(canonical) ? canonical : null;
}
export function displayMillions(value: string): string {
  const [whole, decimals = ''] = value.split('.');
  const negative = whole.startsWith('-');
  const formatted = new Intl.NumberFormat('pt-BR').format(BigInt(whole.replace('-', '')));
  return `${negative ? '−' : ''}${formatted},${decimals.replace(/0+$/, '').padEnd(2, '0')} mi`;
}
export function excelMillions(value: string): number | null {
  const significant = value.replace('-', '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return significant.length <= 15 && Number.isFinite(Number(value)) ? Number(value) : null;
}

const officialOrder = [
  'BRADESCO ECOPLAST', 'BRADESCO LIMPE FACIL', 'BRADESCO GAMMA IND', 'BRADESCO F2G',
  'BRADESCO FAST CLEAN', 'BRADESCO EASY CLEAN', 'BANCO DO BRASIL FAST CLEAN',
  'BANCO DO BRASIL EASY CLEAN', 'BANCO DO BRASIL ECOPLAST', 'BANCO CORA LIMPE FACIL',
  'BANCO CORA MY CLEAN', 'BANCO CORA ECO PLAST', 'CAIXA ECOPLAST', 'CAIXA LIMPE FACIL',
  'CAIXA GAMMA', 'CAIXA FAST CLEAN', 'CAIXA EASY CLEAN',
];
export function directorAccounts(accounts: BankPosition[]): BankPosition[] {
  const rank = (account: BankPosition) => {
    const index = officialOrder.indexOf(account.display_name ?? '');
    return index < 0 ? officialOrder.length : index;
  };
  return [...accounts].sort((a, b) => rank(a) - rank(b));
}
