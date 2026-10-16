import { MAX_FILE_BYTES, MAX_ROWS, parseCivilDate, parseMoneyCents, parseCsv, validateWorkbookExpandedSize } from './payables-parser.mjs';
export { MAX_FILE_BYTES, MAX_ROWS, parseCsv, validateWorkbookExpandedSize };
export const COLUMN_LABELS = { document: 'Documento / NF', client_name: 'Cliente / Órgão', branch: 'Filial', due_date: 'Vencimento', amount_cents: 'Valor', issued_on: 'Emissão', client_document: 'CNPJ' };
const REQUIRED = ['document', 'client_name', 'branch', 'due_date', 'amount_cents'];
const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ALIASES = {
  document: ['DOCUMENTO', 'NF', 'NOTAFISCAL', 'NUMERODOCUMENTO', 'NUMERONF'],
  client_name: ['CLIENTE', 'ORGAO', 'CLIENTEORGAO', 'ORGAOCLIENTE'],
  branch: ['FILIAL', 'CODFILIAL'],
  due_date: ['VENCIMENTO', 'DATAVENCIMENTO', 'DTVENCIMENTO'],
  amount_cents: ['VALOR', 'VALORTITULO', 'VALORORIGINAL'],
  issued_on: ['EMISSAO', 'DATAEMISSAO', 'DTEMISSAO'],
  client_document: ['CNPJ', 'CNPJCLIENTE', 'DOCUMENTOCLIENTE'],
};
const headerMap = new Map(Object.entries(ALIASES).flatMap(([key, aliases]) => aliases.map(alias => [alias, key])));
function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && !(value instanceof Date)) {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('Fórmula não permitida. Salve uma cópia apenas com valores.');
    if ('richText' in value) return scalar(value.richText.map(part => part.text).join(''));
    if ('text' in value && 'hyperlink' in value) return scalar(value.text);
    throw new Error('Célula com conteúdo não suportado. Use somente valores.');
  }
  if (typeof value === 'string' && /^\s*[=+@]/.test(value)) throw new Error('Conteúdo interpretável como fórmula. Salve somente valores.');
  if (!['string','number'].includes(typeof value) && !(value instanceof Date)) throw new Error('Tipo de célula inválido. Use somente texto, data ou número.');
  return value;
}
export function receivableCustomerKey(row) {
  return row.client_document ? `cnpj:${row.client_document}` : `name:${row.client_name.trim().replace(/\s+/g, ' ').toUpperCase()}`;
}
export function validateReceivableRows(matrix, { excel1904 = false } = {}) {
  const errors = [], rows = [];
  if (!matrix.length) return { rows, errors: [{ line: 1, column: 'Arquivo', problem: 'Arquivo vazio.', correction: 'Exporte o relatório completo com os cabeçalhos.' }] };
  if (matrix[0].length > 100) return { rows, errors: [{ line: 1, column: 'Arquivo', problem: 'Mais de 100 colunas.', correction: 'Salve uma cópia com até 100 colunas.' }] };
  const columns = new Map();
  matrix[0].forEach((value, index) => {
    let key;
    try { key = headerMap.get(normalize(scalar(value))); }
    catch { errors.push({ line: 1, column: 'Cabeçalho', problem: 'Cabeçalho inválido.', correction: 'Use nomes de colunas sem fórmulas.' }); return; }
    if (key && columns.has(key)) errors.push({ line: 1, column: COLUMN_LABELS[key], problem: 'Coluna duplicada ou ambígua.', correction: 'Mantenha uma única coluna para este campo.' });
    else if (key) columns.set(key, index);
  });
  for (const key of REQUIRED) if (!columns.has(key)) errors.push({ line: 1, column: COLUMN_LABELS[key], problem: 'Coluna obrigatória ausente.', correction: `Inclua a coluna ${COLUMN_LABELS[key]}.` });
  if (errors.length) return { rows, errors };
  const keys = new Set(), recognized = new Set(columns.values()); let total = 0, nonempty = 0;
  for (let index = 1; index < matrix.length; index++) {
    const source = matrix[index];
    if (source.every(value => value === null || value === undefined || String(value).trim() === '')) continue;
    if (++nonempty > MAX_ROWS) { errors.push({ line: index + 1, column: 'Arquivo', problem: 'Mais de 5.000 linhas.', correction: 'Exporte uma origem completa dentro do limite.' }); break; }
    const row = { document: '', client_name: '', client_document: null, branch: '', issued_on: null, due_date: '', amount_cents: 0 };
    const before = errors.length;
    if (source.length > 100 || (source.length > matrix[0].length && source.slice(matrix[0].length).some(value => value !== null && value !== undefined && String(value).trim()))) errors.push({ line: index + 1, column: 'Arquivo', problem: 'Há valores fora das colunas do cabeçalho ou mais de 100 colunas.', correction: 'Confira delimitadores e cabeçalhos; valores com vírgula em CSV devem estar entre aspas.' });
    source.forEach((value, column) => {
      if (!recognized.has(column)) try { scalar(value); }
      catch (error) { errors.push({ line: index + 1, column: `Coluna ${column + 1}`, problem: error.message, correction: 'Salve uma cópia somente com valores, sem fórmulas.' }); }
    });
    for (const [key, column] of columns) {
      try {
        const value = scalar(source[column]);
        if (key === 'amount_cents') row[key] = parseMoneyCents(value);
        else if (key === 'due_date') row[key] = parseCivilDate(value, excel1904);
        else if (key === 'issued_on') row[key] = String(value).trim() ? parseCivilDate(value, excel1904) : null;
        else if (key === 'client_document') {
          const document = String(value).trim();
          if (!document) row[key] = null;
          else {
            if (!/^[\d.\s/-]+$/.test(document)) throw new Error('CNPJ inválido. Informe 14 dígitos, com ou sem pontuação.');
            const digits = document.replace(/\D/g, '');
            if (digits.length !== 14) throw new Error('CNPJ deve conter exatamente 14 dígitos. Não complete zeros automaticamente.');
            row[key] = digits;
          }
        } else {
          row[key] = String(value).trim().replace(/\s+/g, ' ');
          if (!row[key]) throw new Error('Campo obrigatório vazio.');
          const maximum = key === 'client_name' ? 1500 : 150;
          if (row[key].length > maximum) throw new Error(`Limite de ${maximum} caracteres excedido.`);
        }
      } catch (error) { errors.push({ line: index + 1, column: COLUMN_LABELS[key], problem: error.message, correction: 'Corrija a célula no arquivo original e selecione uma nova cópia.' }); }
    }
    const identity = JSON.stringify([row.branch, row.document, receivableCustomerKey(row), row.due_date, row.amount_cents]);
    if (errors.length === before && keys.has(identity)) errors.push({ line: index + 1, column: 'Documento / NF', problem: 'Chave de título duplicada na mesma base.', correction: 'Confira filial, documento, cliente, vencimento e valor. Não remova duplicados sem validar a origem.' });
    if (errors.length === before) {
      total += row.amount_cents;
      if (!Number.isSafeInteger(total)) errors.push({ line: index + 1, column: 'Valor', problem: 'Total do relatório excede o limite de precisão.', correction: 'Confira valores e origem da base antes de importar.' });
      else { keys.add(identity); rows.push(row); }
    }
    if (errors.length >= 100) break;
  }
  if (!rows.length && !errors.length) errors.push({ line: 2, column: 'Arquivo', problem: 'Não há títulos no relatório.', correction: 'Selecione um relatório completo com títulos; uma base vazia não pode gerar ausências.' });
  return { rows: errors.length ? [] : rows, errors: errors.slice(0,100) };
}
