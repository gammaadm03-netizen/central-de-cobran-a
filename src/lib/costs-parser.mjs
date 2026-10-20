const MAX_ROWS = 5000;
const MAX_FRACTION = 6;
const MAX_WHOLE_DIGITS = 12;
const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const aliases = {
  code: ['Produto: código', 'Código do produto', 'Código', 'Cód. produto'],
  product: ['Produto: nome', 'Nome do produto', 'Produto', 'Descrição do produto'],
  weight: ['peso', 'Peso do produto'],
  unit_cost: ['custo atual', 'Custo unitário', 'Custo por item'],
};
const headers = new Map(Object.entries(aliases).flatMap(([key, values]) => values.map(value => [normalize(value), key])));
const correction = 'Confira o código, o nome, o peso e o custo da linha. Salve uma cópia somente com valores e analise novamente.';

function scalar(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('Fórmulas não são permitidas. Salve uma cópia somente com valores.');
    if (Array.isArray(value.richText)) return value.richText.map(item => item.text ?? '').join('');
    if ('text' in value && 'hyperlink' in value) return value.text;
    throw new Error('Célula não suportada. Salve uma cópia somente com valores.');
  }
  if (typeof value === 'string' && /^\s*[=+@]/.test(value)) throw new Error('Conteúdo interpretável como fórmula. Salve somente valores.');
  if (!['string', 'number'].includes(typeof value)) throw new Error('Célula não suportada.');
  return value;
}
function text(value, required = true) {
  const result = String(scalar(value)).trim();
  if (required && !result) throw new Error('Campo obrigatório vazio.');
  if (result.length > 500 || /[\u0000-\u001f\u007f]/.test(result)) throw new Error('Texto inválido ou maior que 500 caracteres.');
  return result;
}
function code(value) {
  value = scalar(value);
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('O código numérico precisa ser um inteiro exato e positivo.');
  const result = text(value);
  if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)[eE][+-]?\d+$/.test(result)) throw new Error('Código em notação científica. Exporte o código como texto.');
  return result;
}
function trimmedDecimal(value) {
  let [whole, fraction = ''] = value.split('.');
  whole = whole.replace(/^0+(?=\d)/, '');
  fraction = fraction.replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
function numericDecimal(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error('Informe um número positivo ou zero.');
  if (value >= 1e12) throw new Error('Use até 12 dígitos inteiros e seis casas decimais, sem arredondamento.');
  const original = trimmedDecimal(String(value));
  if (/^\d+(?:\.\d{1,6})?$/.test(original)) return original;
  // Excel stores binary doubles. Clean only a tail no farther than two ULPs
  // from an exact six-place decimal, rather than rounding financial precision.
  const decimal = value.toFixed(MAX_FRACTION), nearest = Number(decimal);
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  const exponent = (view.getUint32(0) >>> 20) & 0x7ff;
  const ulp = exponent ? 2 ** (exponent - 1023 - 52) : Number.MIN_VALUE;
  // At large magnitudes an ULP can itself contain a genuine seventh decimal.
  // Those ambiguous inputs must be supplied as decimal text instead.
  if (nearest !== 0 && Number.isFinite(nearest) && 2 * ulp <= 1e-9 && Math.abs(value - nearest) <= 2 * ulp) return trimmedDecimal(decimal);
  throw new Error('Número fora do limite de seis casas decimais, sem arredondamento.');
}
/** Preserve unit precision as decimal text; never round a unit cost to cents. */
export function parseCostDecimal(value, { optional = false, currency = false } = {}) {
  value = scalar(value);
  if (value === '') {
    if (optional) return null;
    throw new Error('Custo obrigatório vazio; informe zero somente quando o custo for realmente zero.');
  }
  let canonical;
  if (typeof value === 'number') {
    canonical = numericDecimal(value);
  } else {
    let raw = String(value).trim();
    if (currency) raw = raw.replace(/^R\$\s*/, '');
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/.test(raw)) throw new Error('Use número brasileiro, por exemplo 1.234,5678.');
    canonical = raw.replaceAll('.', '').replace(',', '.');
  }
  let [whole, fraction = ''] = trimmedDecimal(canonical).split('.');
  if (whole.length > MAX_WHOLE_DIGITS || fraction.length > MAX_FRACTION) throw new Error('Use até 12 dígitos inteiros e seis casas decimais, sem arredondamento.');
  return fraction ? `${whole}.${fraction}` : whole;
}
export function isCostCodeHeader(value) {
  try { return headers.get(normalize(scalar(value))) === 'code'; } catch { return false; }
}
/** XLSX numeric codes may use a zero mask; retain those meaningful zeros. */
export function readCostCodeCell(value, numFmt) {
  if (typeof value !== 'number') return value;
  const result = code(value), format = String(numFmt ?? '').trim();
  if (!format || ['GENERAL', '@'].includes(format.toUpperCase())) return result;
  if (!/^0{1,150}$/.test(format)) throw new Error('Formato do código não suportado. Exporte os códigos como texto.');
  return result.padStart(format.length, '0');
}
export function validateCostRows(matrix) {
  const rows = [], errors = [];
  const issue = (line, column, problem) => errors.push({ line, column, problem, correction });
  if (!Array.isArray(matrix) || matrix.length < 2 || matrix.length > MAX_ROWS + 1 || !Array.isArray(matrix[0]) || matrix[0].length > 100) {
    issue(1, 'Arquivo', 'Informe de 1 a 5.000 itens de custo.');
    return { rows, errors };
  }
  const mapped = new Map();
  for (const [index, value] of (matrix[0] ?? []).entries()) {
    try {
      const key = headers.get(normalize(scalar(value)));
      if (key && mapped.has(key)) issue(1, String(value), 'Coluna duplicada ou ambígua.');
      else if (key) mapped.set(key, index);
    } catch (error) { issue(1, 'Cabeçalho', error.message); }
  }
  for (const key of ['code', 'product', 'unit_cost']) if (!mapped.has(key)) issue(1, aliases[key][0], 'Coluna obrigatória ausente.');
  if (errors.length) return { rows, errors };
  for (let index = 1; index < matrix.length; index++) {
    const source = matrix[index], line = index + 1;
    if (!Array.isArray(source) || source.length > 100) { issue(line, 'Linha', 'A linha excede 100 colunas ou possui estrutura inválida.'); continue; }
    if (source.every(value => value == null || value === '')) continue;
    try {
      source.forEach(scalar);
      if (source.slice(matrix[0].length).some(value => value != null && value !== '')) throw new Error('Há valores fora das colunas do cabeçalho.');
      const get = key => mapped.has(key) ? source[mapped.get(key)] : '';
      const item = { line_number: line, code: code(get('code')), product: text(get('product')), weight_kg: parseCostDecimal(get('weight'), { optional: true }), unit_cost: parseCostDecimal(get('unit_cost'), { optional: true, currency: true }) };
      rows.push(item);
    } catch (error) { issue(line, 'Item de custo', error.message); }
  }
  if (!rows.length && !errors.length) issue(2, 'Arquivo', 'Não há itens de custo no relatório.');
  return { rows, errors };
}
