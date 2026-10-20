import { MAX_FILE_BYTES, MAX_ROWS, parseCivilDate, parseMoneyCents, parseCsv, validateWorkbookExpandedSize } from './payables-parser.mjs';
export { MAX_FILE_BYTES, MAX_ROWS, parseCsv, validateWorkbookExpandedSize };
export const COLUMN_LABELS = { document: 'Documento / NF', client_name: 'Cliente / Órgão', branch: 'Filial', due_date: 'Vencimento', amount_cents: 'Valor', issued_on: 'Emissão', client_document: 'CNPJ', received_on: 'Quitação: data do recebimento', received_amount_cents: 'Quitação: valor recebido' };
const REQUIRED = ['document', 'client_name', 'branch', 'due_date', 'amount_cents'];
const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ALIASES = {
  document: ['DOCUMENTO', 'NF', 'NOTAFISCAL', 'NUMERODOCUMENTO', 'NUMERONF', 'DOCUMENTONUMERO'],
  client_name: ['CLIENTE', 'ORGAO', 'CLIENTEORGAO', 'ORGAOCLIENTE', 'ENTIDADE1ENTIDADENOME'],
  branch: ['FILIAL', 'CODFILIAL'],
  due_date: ['VENCIMENTO', 'DATAVENCIMENTO', 'DTVENCIMENTO', 'VENCIMENTODATA'],
  amount_cents: ['VALOR', 'VALORTITULO', 'VALORORIGINAL', 'EMISSAOVALORDOLANCAMENTO'],
  issued_on: ['EMISSAO', 'DATAEMISSAO', 'DTEMISSAO', 'EMISSAODATA'],
  client_document: ['CNPJ', 'CNPJCLIENTE', 'DOCUMENTOCLIENTE'],
  received_on: ['QUITACAODATADORECEBIMENTO'],
  received_amount_cents: ['QUITACAOVALORRECEBIDO'],
};
const headerMap = new Map(Object.entries(ALIASES).flatMap(([key, aliases]) => aliases.map(alias => [alias, key])));
const ERP_TIMESTAMP_HEADERS = new Set(['EMISSAODATA', 'VENCIMENTODATA', 'QUITACAODATADORECEBIMENTO']);
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
function parseErpDate(value, excel1904) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Data inválida.');
    return parseCivilDate(`${String(value.getUTCFullYear()).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 1 || value > 2958465) throw new Error('Data Excel inválida.');
    return parseCivilDate(Math.floor(value), excel1904);
  }
  const timestamp = /^(\d{2}\/\d{2}\/\d{4}) +(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? '').trim());
  if (!timestamp) return parseCivilDate(value, excel1904);
  if (+timestamp[2] > 23 || +timestamp[3] > 59 || +(timestamp[4] ?? 0) > 59) throw new Error('Horário inválido. Use hh:mm ou hh:mm:ss, entre 00:00:00 e 23:59:59.');
  return parseCivilDate(timestamp[1], excel1904);
}
const INVALID_IDENTIFIER = 'Identificador de documento inválido. Use texto ou número inteiro não negativo, sem notação científica.';
const UNSUPPORTED_IDENTIFIER_FORMAT = 'Formato do identificador não suportado. No Excel, use Texto ou um formato simples de zeros, como 000000.';
function parseIdentifier(value) {
  const primitive = scalar(value);
  if (typeof primitive === 'number') {
    if (!Number.isSafeInteger(primitive) || primitive < 0) throw new Error(INVALID_IDENTIFIER);
    return String(primitive);
  }
  if (typeof primitive !== 'string') throw new Error(INVALID_IDENTIFIER);
  const text = primitive.trim().replace(/\s+/g, ' ');
  if (text.length > 150) throw new Error('Limite de 150 caracteres excedido.');
  if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)[eE][+-]?\d+$/.test(text) || /^-\d+(?:[.,]\d+)?$/.test(text) || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(INVALID_IDENTIFIER);
  return text;
}
export function isReceivableIdentifierHeader(value) {
  return headerMap.get(normalize(scalar(value))) === 'document';
}
export function readReceivableIdentifierCell(value, numFmt) {
  if (value instanceof Date) throw new Error(UNSUPPORTED_IDENTIFIER_FORMAT);
  const text = parseIdentifier(value);
  if (typeof value !== 'number') return text;
  const format = String(numFmt ?? '').trim();
  if (!format || format.toUpperCase() === 'GENERAL' || format === '@') return text;
  if (!/^0+$/.test(format)) throw new Error(UNSUPPORTED_IDENTIFIER_FORMAT);
  if (format.length > 150) throw new Error('Limite de 150 caracteres excedido.');
  return text.padStart(format.length, '0');
}
/** Keep the original invalid cell in the matrix and report its exact position. */
export function readReceivableIdentifierCellResult(value, numFmt, line, column) {
  try { return { value: readReceivableIdentifierCell(value, numFmt), error: null }; }
  catch (error) {
    let letters = '', index = column;
    while (index > 0) { index--; letters = String.fromCharCode(65 + index % 26) + letters; index = Math.floor(index / 26); }
    const address = `${letters}${line}`;
    return { value, error: { line, column: `${COLUMN_LABELS.document} (${address})`,
      problem: error instanceof Error ? error.message : INVALID_IDENTIFIER,
      correction: `Confira a célula ${address} e o alinhamento da linha no arquivo original. Mantenha a nota, o valor e as datas nas respectivas colunas.` } };
  }
}
/** An adapter format error takes precedence over the parser's same-cell error. */
export function mergeReceivableImportProblems(parserErrors, cellErrors = []) {
  const seen = new Set(), errors = [];
  for (const error of [...cellErrors, ...parserErrors]) {
    const column = error.column.replace(/ \([A-Z]+\d+\)$/, ''), key = JSON.stringify([error.line, column]);
    if (!seen.has(key)) { seen.add(key); errors.push(error); }
  }
  return errors.sort((first, second) => first.line - second.line || first.column.localeCompare(second.column, 'pt-BR')).slice(0, 100);
}
export function receivableCustomerKey(row) {
  return row.client_document ? `cnpj:${row.client_document}` : `name:${row.client_name.trim().replace(/\s+/g, ' ').toUpperCase()}`;
}
function validateReceivableMatrix(matrix, { excel1904 = false } = {}, received = false) {
  const errors = [], rows = [];
  if (!matrix.length) return { rows, errors: [{ line: 1, column: 'Arquivo', problem: 'Arquivo vazio.', correction: 'Exporte o relatório completo com os cabeçalhos.' }] };
  if (matrix[0].length > 100) return { rows, errors: [{ line: 1, column: 'Arquivo', problem: 'Mais de 100 colunas.', correction: 'Salve uma cópia com até 100 colunas.' }] };
  const columns = new Map(), timestampColumns = new Set();
  matrix[0].forEach((value, index) => {
    let key;
    try {
      const normalizedHeader = normalize(scalar(value));
      key = headerMap.get(normalizedHeader);
      if (ERP_TIMESTAMP_HEADERS.has(normalizedHeader)) timestampColumns.add(index);
    }
    catch { errors.push({ line: 1, column: 'Cabeçalho', problem: 'Cabeçalho inválido.', correction: 'Use nomes de colunas sem fórmulas.' }); return; }
    if (key && columns.has(key)) errors.push({ line: 1, column: COLUMN_LABELS[key], problem: 'Coluna duplicada ou ambígua.', correction: 'Mantenha uma única coluna para este campo.' });
    else if (key) columns.set(key, index);
  });
  for (const key of [...REQUIRED, ...(received ? ['received_on', 'received_amount_cents'] : [])]) if (!columns.has(key)) errors.push({ line: 1, column: COLUMN_LABELS[key], problem: 'Coluna obrigatória ausente.', correction: `Inclua a coluna ${COLUMN_LABELS[key]}.` });
  if (errors.length) return { rows, errors };
  const keys = new Set(), recognized = new Set(columns.values()); let total = 0, receivedTotal = 0, nonempty = 0;
  for (let index = 1; index < matrix.length; index++) {
    const source = matrix[index];
    if (source.every(value => value === null || value === undefined || String(value).trim() === '')) continue;
    if (++nonempty > MAX_ROWS) { errors.push({ line: index + 1, column: 'Arquivo', problem: 'Mais de 5.000 linhas.', correction: 'Exporte uma origem completa dentro do limite.' }); break; }
    const row = { document: '', client_name: '', client_document: null, branch: '', issued_on: null, due_date: '', amount_cents: 0 };
    if (received) { row.received_on = ''; row.received_amount_cents = 0; }
    const before = errors.length;
    if (source.length > 100 || (source.length > matrix[0].length && source.slice(matrix[0].length).some(value => value !== null && value !== undefined && String(value).trim()))) errors.push({ line: index + 1, column: 'Arquivo', problem: 'Há valores fora das colunas do cabeçalho ou mais de 100 colunas.', correction: 'Confira delimitadores e cabeçalhos; valores com vírgula em CSV devem estar entre aspas.' });
    source.forEach((value, column) => {
      if (!recognized.has(column)) try { scalar(value); }
      catch (error) { errors.push({ line: index + 1, column: `Coluna ${column + 1}`, problem: error.message, correction: 'Salve uma cópia somente com valores, sem fórmulas.' }); }
    });
    for (const [key, column] of columns) {
      try {
        const value = scalar(source[column]);
        if (!received && ['received_on', 'received_amount_cents'].includes(key)) continue;
        if (key === 'amount_cents' || key === 'received_amount_cents') {
          row[key] = parseMoneyCents(value);
          if (key === 'received_amount_cents' && row[key] <= 0) throw new Error('O valor recebido deve ser maior que zero.');
        }
        else if (key === 'due_date' || key === 'received_on') row[key] = timestampColumns.has(column) ? parseErpDate(value, excel1904) : parseCivilDate(value, excel1904);
        else if (key === 'issued_on') row[key] = String(value).trim() ? (timestampColumns.has(column) ? parseErpDate(value, excel1904) : parseCivilDate(value, excel1904)) : null;
        else if (key === 'document') {
          row[key] = parseIdentifier(value);
          if (!row[key]) throw new Error('Campo obrigatório vazio.');
        }
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
    const identity = JSON.stringify([row.branch, row.document, receivableCustomerKey(row), row.due_date]);
    if (errors.length === before && keys.has(identity)) errors.push({ line: index + 1, column: 'Documento / NF', problem: 'Chave de título duplicada na mesma base.', correction: 'Confira filial, documento, cliente e vencimento. Uma alteração de valor não cria outro título.' });
    if (errors.length === before) {
      total += row.amount_cents;
      if (received) receivedTotal += row.received_amount_cents;
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(receivedTotal)) errors.push({ line: index + 1, column: 'Valor', problem: 'Total do relatório excede o limite de precisão.', correction: 'Confira valores e origem da base antes de importar.' });
      else { keys.add(identity); rows.push(row); }
    }
    if (errors.length >= 100) break;
  }
  if (!rows.length && !errors.length) errors.push({ line: 2, column: 'Arquivo', problem: 'Não há títulos no relatório.', correction: 'Selecione um relatório completo com títulos; uma base vazia não pode gerar ausências.' });
  return { rows: errors.length ? [] : rows, errors: errors.slice(0,100) };
}
export function validateReceivableRows(matrix, options = {}) { return validateReceivableMatrix(matrix, options, false); }
export function validateReceivablePaidRows(matrix, options = {}) { return validateReceivableMatrix(matrix, options, true); }
