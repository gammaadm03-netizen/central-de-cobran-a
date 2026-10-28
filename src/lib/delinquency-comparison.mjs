export const DELINQUENCY_BANDS = Object.freeze([
  { key: '1_30', label: '1–30 dias' },
  { key: '31_60', label: '31–60 dias' },
  { key: '61_90', label: '61–90 dias' },
  { key: '91_180', label: '91–180 dias' },
  { key: '181_365', label: '181–365 dias' },
  { key: 'ACIMA_365', label: '>365 dias' },
].map(Object.freeze));

function civilDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01') return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function amount(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validPosition(position, asOf, firstAvailable) {
  if (!object(position) || !civilDate(position.date) || position.date > asOf
    || typeof position.available !== 'boolean' || typeof position.partial !== 'boolean'
    || position.partial && position.date !== asOf || !Array.isArray(position.bands)
    || position.bands.length !== DELINQUENCY_BANDS.length) return false;
  if (position.available && (!firstAvailable || position.date < firstAvailable || position.partial !== (position.date === asOf))) return false;
  const seen = new Set();
  let total = 0n, count = 0n;
  for (const band of position.bands) {
    if (!object(band) || !DELINQUENCY_BANDS.some(item => item.key === band.key) || seen.has(band.key)) return false;
    seen.add(band.key);
    if (!position.available) {
      if (band.amount_cents !== null || band.title_count !== null) return false;
    } else {
      if (!amount(band.amount_cents) || !amount(band.title_count)) return false;
      total += BigInt(band.amount_cents); count += BigInt(band.title_count);
    }
  }
  return position.available
    ? amount(position.total_cents) && amount(position.title_count)
      && total === BigInt(position.total_cents) && count === BigInt(position.title_count)
    : position.total_cents === null && position.title_count === null;
}

export function validDelinquencyComparison(value) {
  return object(value) && civilDate(value.as_of_date) && value.timezone === 'America/Sao_Paulo'
    && (value.first_available_date === null || civilDate(value.first_available_date) && value.first_available_date <= value.as_of_date)
    && validPosition(value.previous, value.as_of_date, value.first_available_date)
    && validPosition(value.current, value.as_of_date, value.first_available_date)
    && value.previous.date < value.current.date;
}

const groupedInteger = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
function formattedPercentage(difference, previous) {
  const magnitude = difference < 0n ? -difference : difference;
  const numerator = magnitude * 10000n;
  const basisPoints = numerator / previous + (numerator % previous * 2n >= previous ? 1n : 0n);
  const sign = difference < 0n ? '-' : difference > 0n ? '+' : '';
  return `${sign}${groupedInteger.format(basisPoints / 100n)},${String(basisPoints % 100n).padStart(2, '0')}%`;
}

export function delinquencyChange(previous, current) {
  if (!amount(previous) || !amount(current)) return { difference_cents: null, percentage: null, label: 'Sem histórico', tone: 'unavailable' };
  const difference = BigInt(current) - BigInt(previous);
  const difference_cents = Number(difference);
  if (difference === 0n) return { difference_cents, percentage: '0,00%', label: 'Sem variação', tone: 'neutral' };
  if (previous === 0) return { difference_cents, percentage: null, label: 'Novo saldo vencido', tone: 'negative' };
  const base = BigInt(previous), scaled = difference * 100n;
  const percentage = formattedPercentage(difference, base);
  if (scaled <= -base * 30n) return { difference_cents, percentage, label: 'Excelente', tone: 'positive' };
  if (scaled <= -base * 10n) return { difference_cents, percentage, label: 'Muito positivo', tone: 'positive' };
  if (scaled < -base) return { difference_cents, percentage, label: 'Positivo', tone: 'positive' };
  if (scaled <= base) return { difference_cents, percentage, label: 'Estável', tone: 'neutral' };
  return { difference_cents, percentage, label: 'Atenção', tone: 'negative' };
}
