import { parseCivilDate, parseMoneyCents } from './payables-parser.mjs';

const MAX = Number.MAX_SAFE_INTEGER;
const norm = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const aliases = {
  code: ['CÓDIGO', 'CODIGO', 'COD PRODUTO', 'COD. PRODUTO'],
  product: ['PRODUTO', 'DESCRIÇÃO DO PRODUTO', 'DESCRICAO DO PRODUTO', 'DESCRIÇÃO', 'DESCRICAO'],
  quantity: ['QUANTIDADE', 'QTD'], sale_cents: ['VENDA TOTAL', 'FATURAMENTO', 'VALOR VENDA', 'VALOR TOTAL', 'TOTAL VENDA'],
  freight_cents: ['FRETE TOTAL', 'FRETE'], issued_on: ['EMISSÃO', 'EMISSAO', 'DATA NOTA', 'DATA VENDA'],
  client: ['CLIENTE', 'ENTIDADE'], employee: ['FUNCIONÁRIO COMISSIONADO', 'FUNCIONARIO COMISSIONADO', 'VENDEDOR', 'FUNCIONÁRIO', 'FUNCIONARIO'],
  invoice: ['NOTA FISCAL', 'NÚMERO NF', 'NUMERO NF', 'NFE', 'NF'], cost_center: ['CENTRO DE CUSTO', 'SETOR'], branch: ['FILIAL'],
  tax_cents: ['IMPOSTO TOTAL', 'IMPOSTOS', 'IMPOSTO'], cost_cents: ['CMV TOTAL', 'CMV', 'CUSTO TOTAL'],
  commission_cents: ['COMISSÃO TOTAL', 'COMISSAO TOTAL', 'COMISSÃO', 'COMISSAO'],
  margin_cents: ['MARGEM LÍQUIDA FINAL R$', 'MARGEM LIQUIDA FINAL R$', 'MARGEM FINAL R$', 'MARGEM LÍQUIDA FINAL', 'MARGEM LIQUIDA FINAL', 'MARGEM FINAL'],
};
const headers = new Map(Object.entries(aliases).flatMap(([key, values]) => values.map(value => [norm(value), key])));
function scalar(value) {
  if (value == null) return '';
  if (typeof value === 'object' && !(value instanceof Date)) {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('Fórmula não permitida. Salve uma cópia apenas com valores.');
    if (Array.isArray(value.richText)) return value.richText.map(item => item.text ?? '').join('');
    if ('text' in value && 'hyperlink' in value) return value.text;
    throw new Error('Célula não suportada. Salve uma cópia somente com valores.');
  }
  if (typeof value === 'string' && /^\s*[=+@]/.test(value)) throw new Error('Conteúdo interpretável como fórmula. Salve somente valores.');
  return value;
}
function text(value, required = false) {
  const result = String(scalar(value)).trim();
  if (required && !result) throw new Error('Campo obrigatório vazio.');
  if (result.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) throw new Error('Texto inválido ou maior que 500 caracteres.');
  return result;
}
function money(value) {
  value = scalar(value);
  if (value === '') return null;
  if (typeof value === 'number') return value < 0 ? -parseMoneyCents(-value) : parseMoneyCents(value);
  const raw = String(value).trim(), negative = /^-/.test(raw) || /^\(.*\)$/.test(raw);
  const unsigned = raw.replace(/^-\s*/, '').replace(/^\((.*)\)$/, '$1').trim();
  return (negative ? -1 : 1) * parseMoneyCents(unsigned);
}
function date(value, excel1904) {
  value = scalar(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) return parseCivilDate(new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())), excel1904);
  if (typeof value === 'number') return parseCivilDate(Math.floor(value), excel1904);
  const timestamp = /^(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(value));
  if (timestamp && (+timestamp[2] > 23 || +timestamp[3] > 59 || +(timestamp[4] ?? 0) > 59)) throw new Error('Horário inválido.');
  return parseCivilDate(timestamp?.[1] ?? value, excel1904);
}
export function validateCommercialRows(matrix, { excel1904 = false } = {}) {
  const errors = [], rows = [];
  const issue = (line, column, problem) => errors.push({ line, column, problem, correction: 'Confira o cabeçalho e os valores da linha; salve uma cópia somente com valores e analise novamente.' });
  if (!Array.isArray(matrix) || matrix.length < 2 || matrix.length > 5001) { issue(1, 'Arquivo', 'Informe de 1 a 5.000 itens de fechamento.'); return { rows, errors }; }
  const mapped = new Map();
  for (const [index, value] of (matrix[0] ?? []).entries()) {
    try {
      const header = norm(scalar(value));
      const key = headers.get(header);
      if (key && mapped.has(key)) issue(1, String(value), 'Coluna duplicada ou ambígua.');
      else if (key) mapped.set(key, index);
    } catch (error) { issue(1, 'Cabeçalho', error.message); }
  }
  for (const key of ['product', 'sale_cents', 'issued_on', 'client', 'branch']) if (!mapped.has(key)) issue(1, aliases[key][0], 'Coluna obrigatória ausente.');
  if (errors.length) return { rows, errors };
  for (let index = 1; index < matrix.length; index++) {
    const source = matrix[index];
    if (!Array.isArray(source) || source.length > 100) { issue(index + 1, 'Linha', 'A linha excede 100 colunas.'); continue; }
    if (source.every(value => value == null || value === '')) continue;
    try {
      // Inspect unknown columns too: no executable formulas are accepted in originals.
      source.forEach(scalar);
      if (source.slice(matrix[0].length).some(value => value != null && value !== '')) throw new Error('Há valores fora das colunas do cabeçalho.');
      const get = key => mapped.has(key) ? source[mapped.get(key)] : '';
      const row = { line_number: index + 1 };
      for (const key of ['code', 'product', 'client', 'employee', 'invoice', 'cost_center', 'branch']) row[key] = text(get(key), ['product', 'client', 'branch'].includes(key));
      row.issued_on = date(get('issued_on'), excel1904);
      for (const key of ['sale_cents', 'freight_cents', 'tax_cents', 'cost_cents', 'commission_cents', 'margin_cents']) row[key] = money(get(key));
      if (row.sale_cents === null) throw new Error('Valor da venda obrigatório.');
      const quantity = text(get('quantity'));
      row.quantity = quantity === '' ? null : Number(quantity.replace(',', '.'));
      if (row.quantity !== null && (!Number.isFinite(row.quantity) || Math.abs(row.quantity) > 1000000000 || !/^-?\d+(?:[.,]\d{1,6})?$/.test(quantity))) throw new Error('Quantidade inválida; use no máximo seis casas decimais.');
      row.margin_source = row.margin_cents !== null ? 'PROVIDED' : ['freight_cents', 'tax_cents', 'cost_cents', 'commission_cents'].every(key => row[key] !== null) ? 'CALCULATED' : 'UNAVAILABLE';
      if (row.margin_source === 'CALCULATED') {
        const derived = BigInt(row.sale_cents) - BigInt(row.freight_cents) - BigInt(row.tax_cents) - BigInt(row.cost_cents) - BigInt(row.commission_cents);
        if (derived > BigInt(MAX) || derived < -BigInt(MAX)) throw new Error('Valor excede o limite seguro.');
        row.margin_cents = Number(derived);
      }
      if (row.margin_cents !== null && !Number.isSafeInteger(row.margin_cents)) throw new Error('Valor excede o limite seguro.');
      rows.push(row);
    } catch (error) { issue(index + 1, 'Item de fechamento', error.message); }
  }
  if (!rows.length && !errors.length) issue(2, 'Arquivo', 'Não há itens no relatório.');
  for (const key of ['sale_cents', 'freight_cents', 'tax_cents', 'cost_cents', 'commission_cents', 'margin_cents']) {
    if (rows.reduce((sum, row) => sum + BigInt(Math.abs(row[key] ?? 0)), 0n) > BigInt(MAX)) issue(0, aliases[key][0], 'Total do relatório excede o limite de precisão.');
  }
  return { rows, errors };
}
