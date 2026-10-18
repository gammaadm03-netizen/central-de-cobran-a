/** Civil dates are calculated in UTC so a browser's timezone cannot shift a day. */
function civilDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Informe uma data válida no formato AAAA-MM-DD.');
  const [year, month, day] = value.split('-').map(Number);
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(12, 0, 0, 0);
  if (year < 1 || result.getUTCFullYear() !== year || result.getUTCMonth() !== month - 1 || result.getUTCDate() !== day) {
    throw new Error('Informe uma data existente.');
  }
  return result;
}

export function addCivilDays(value: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new Error('Quantidade de dias inválida.');
  const result = civilDate(value);
  result.setUTCDate(result.getUTCDate() + days);
  if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() < 1 || result.getUTCFullYear() > 9999) throw new Error('Data fora do intervalo permitido.');
  return result.toISOString().slice(0, 10);
}

export function financialWeek(value: string): { start: string; end: string } {
  const start = addCivilDays(value, -((civilDate(value).getUTCDay() + 1) % 7));
  return { start, end: addCivilDays(start, 6) };
}

export function financialWeekLabel(value: string): string {
  const { start, end } = financialWeek(value);
  const display = (date: string) => date.split('-').reverse().join('/');
  return `${display(start)} a ${display(end)}`;
}

export function monthBounds(value: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value.startsWith('0000')) throw new Error('Selecione um mês válido.');
  const start = `${value}-01`;
  const result = civilDate(start);
  result.setUTCMonth(result.getUTCMonth() + 1, 0);
  return { start, end: result.toISOString().slice(0, 10) };
}

export function previousMonth(value: string): string {
  const result = civilDate(monthBounds(value).start);
  result.setUTCMonth(result.getUTCMonth() - 1);
  if (result.getUTCFullYear() < 1) throw new Error('Mês anterior fora do intervalo permitido.');
  return result.toISOString().slice(0, 7);
}

/** Compare equal ordinal days; an entire selected month compares to an entire prior month. */
export function comparisonRanges(month: string, start = '', end = ''): { current: { start: string; end: string }; previous: { start: string; end: string } } {
  const bounds = monthBounds(month);
  if (start) civilDate(start);
  if (end) civilDate(end);
  if (start && end && start > end) throw new Error('A data inicial deve ser anterior à data final.');
  const current = { start: start && start > bounds.start ? start : bounds.start, end: end && end < bounds.end ? end : bounds.end };
  if (current.start > current.end) throw new Error('Os filtros de vencimento não incluem o mês selecionado. Ajuste o mês ou os filtros.');
  const earlierMonth = previousMonth(month), earlier = monthBounds(earlierMonth);
  if (current.start === bounds.start && current.end === bounds.end) return { current, previous: earlier };
  const lastDay = Number(earlier.end.slice(8));
  const previousDate = (value: string) => `${earlierMonth}-${String(Math.min(Number(value.slice(8)), lastDay)).padStart(2, '0')}`;
  return { current, previous: { start: previousDate(current.start), end: previousDate(current.end) } };
}
