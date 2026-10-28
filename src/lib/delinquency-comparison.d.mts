export type DelinquencyBandKey = '1_30' | '31_60' | '61_90' | '91_180' | '181_365' | 'ACIMA_365';
export interface DelinquencyBand { key: DelinquencyBandKey; amount_cents: number | null; title_count: number | null }
export interface DelinquencyPosition {
  date: string;
  available: boolean;
  partial: boolean;
  total_cents: number | null;
  title_count: number | null;
  bands: DelinquencyBand[];
}
export interface DelinquencyComparison {
  as_of_date: string;
  timezone: 'America/Sao_Paulo';
  first_available_date: string | null;
  previous: DelinquencyPosition;
  current: DelinquencyPosition;
}
export interface DelinquencyChange {
  difference_cents: number | null;
  percentage: string | null;
  label: string;
  tone: 'positive' | 'negative' | 'neutral' | 'unavailable';
}
export const DELINQUENCY_BANDS: readonly Readonly<{ key: DelinquencyBandKey; label: string }>[];
export function validDelinquencyComparison(value: unknown): value is DelinquencyComparison;
export function delinquencyChange(previous: number | null, current: number | null): DelinquencyChange;
