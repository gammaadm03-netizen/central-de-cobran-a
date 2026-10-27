import { isInternalCashBank } from './payable-bank-rules.mjs';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 5000;
const REQUIRED = ['entry_number', 'description', 'due_date', 'amount_cents', 'plan', 'branch'];
export const COLUMN_LABELS = { entry_number: 'Nº lançamento', description: 'Histórico / Favorecido', due_date: 'Vencimento', amount_cents: 'Valor', plan: 'Plano de Contas', branch: 'Filial', bank_account: 'Banco / Conta', issued_on: 'Emissão', source_status: 'Status / Situação', cheque_number: 'Cheque: número' };
const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ALIASES = {
  entry_number: ['LANCAMENTO', 'NLANCAMENTO', 'NOLANCAMENTO', 'NUMEROLANCAMENTO', 'NUMERODOLANCAMENTO', 'NUMEROLANC', 'NROLANCAMENTO'],
  description: ['HISTORICO', 'DESCRICAO', 'HISTORICOFAVORECIDO', 'FAVORECIDO'],
  due_date: ['VENCIMENTO', 'DATAVENCIMENTO', 'DTVENCIMENTO', 'VENCIMENTODATA'],
  amount_cents: ['VALOR', 'VALORTITULO', 'VALORORIGINAL', 'EMISSAOVALORDOLANCAMENTO'],
  plan: ['PLANODECONTAS', 'PLANOCONTAS', 'PLANOCPCONTANOME'],
  branch: ['FILIAL', 'CODFILIAL'],
  bank_account: ['BANCO', 'CONTA', 'BANCOCONTA', 'PLANOCCCONTANOME'],
  issued_on: ['EMISSAO', 'DATAEMISSAO', 'DTEMISSAO', 'EMISSAODATA'],
  source_status: ['STATUS', 'SITUACAO'],
  cheque_number: ['CHEQUENUMERO'],
};
const headerMap = new Map(Object.entries(ALIASES).flatMap(([key, aliases]) => aliases.map(alias => [alias, key])));
// This ERP exports civil dates with a clock component. Only these explicit CP
// columns permit times; the shared date-only parser used by CR remains strict.
const ERP_TIMESTAMP_HEADERS = new Set(['EMISSAODATA', 'VENCIMENTODATA']);
// Paid-only ERP reports can include both the original maturity date and the
// actual payment date. These aliases apply only to the paid validator below.
const PAID_DATE_HEADERS = new Set(['QUITACAODATADOPAGAMENTO', 'DATADOPAGAMENTO', 'DATAPAGAMENTO', 'PAGAMENTODATA']);
const PAID_TIMESTAMP_HEADERS = new Set(['QUITACAODATADOPAGAMENTO', 'PAGAMENTODATA']);
const PAID_COLUMN_LABELS = { ...COLUMN_LABELS, paid_on: 'Quitação: data do pagamento' };

// Date-only values stay civil dates. No UTC/local conversion is applied to user input.
export function parseCivilDate(value, excel1904 = false) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Data inválida.');
    if (value.getUTCHours() || value.getUTCMinutes() || value.getUTCSeconds() || value.getUTCMilliseconds()) throw new Error('A data contém horário. Informe somente a data civil.');
    return civil(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > 2958465 || (!excel1904 && value === 60)) throw new Error('Data Excel inválida ou contém horário.');
    const epoch = excel1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const date = new Date(epoch + (value - (!excel1904 && value > 60 ? 1 : 0)) * 86400000);
    return civil(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const text = String(value ?? '').trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!br && !iso) throw new Error('Use dd/mm/aaaa ou aaaa-mm-dd; datas abreviadas são ambíguas.');
  return br ? civil(+br[3], +br[2], +br[1]) : civil(+iso[1], +iso[2], +iso[3]);
}
function parsePayableErpDate(value, excel1904) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Data inválida.');
    // ExcelJS represents an Excel serial as UTC fields. Preserve those fields,
    // including dates close to midnight, rather than converting to a time zone.
    return civil(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 1 || value > 2958465) throw new Error('Data Excel inválida.');
    return parseCivilDate(Math.floor(value), excel1904);
  }
  const text = String(value ?? '').trim();
  const timestamp = /^(\d{2}\/\d{2}\/\d{4}) +(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!timestamp) return parseCivilDate(value, excel1904);
  if (+timestamp[2] > 23 || +timestamp[3] > 59 || +(timestamp[4] ?? 0) > 59) throw new Error('Horário inválido. Use hh:mm ou hh:mm:ss, entre 00:00:00 e 23:59:59.');
  return parseCivilDate(timestamp[1], excel1904);
}
function civil(year, month, day) {
  if (year < 1900 || year > 2199) throw new Error('Ano fora do intervalo de 1900 a 2199.');
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() + 1 !== month || candidate.getUTCDate() !== day) throw new Error('Data inexistente.');
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function parseMoneyCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error('Informe um valor numérico positivo.');
    const decimal = String(value);
    if (!/^\d+(?:\.\d{1,2})?$/.test(decimal)) throw new Error('O valor deve ter no máximo duas casas decimais, sem arredondamento.');
    const [whole, fraction = ''] = decimal.split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2,'0'));
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Valor excede o limite seguro.');
    return Number(cents);
  }
  let text = String(value ?? '').trim().replace(/^R\$\s*/, '');
  if (!text) throw new Error('Valor obrigatório.');
  // CSV brasileiro: ponto só separa milhares e vírgula separa centavos.
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text)) throw new Error('Use valor brasileiro, por exemplo 1.234,56, com até duas casas decimais.');
  text = text.replaceAll('.', '');
  const [integer, decimal = ''] = text.split(',');
  const cents = BigInt(integer) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Valor excede o limite seguro.');
  return Number(cents);
}

// RFC4180-style parser, preserving quoted delimiters, newlines and escaped quotes.
export function parseCsv(text, { maxRows = MAX_ROWS + 1 } = {}) {
  // Financial imports retain their existing limit. RH can reserve bounded rows
  // for its preamble and final report totals without increasing the person limit.
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS + 21) throw new Error('Limite de linhas do CSV inválido.');
  text = text.replace(/^\uFEFF/, '');
  if (text.includes('\u0000')) throw new Error('CSV contém bytes inválidos. Salve uma cópia em UTF-8.');
  const sample = text.split(/\r?\n/, 1)[0];
  let quoted = false, commas = 0, semicolons = 0;
  for (let index = 0; index < sample.length; index++) {
    if (sample[index] === '"') { if (quoted && sample[index + 1] === '"') index++; else quoted = !quoted; }
    else if (!quoted && sample[index] === ',') commas++;
    else if (!quoted && sample[index] === ';') semicolons++;
  }
  const delimiter = semicolons >= commas ? ';' : ',';
  const rows = []; let row = [], field = '', inQuote = false, closedQuote = false;
  function finishField() { row.push(field); field = ''; closedQuote = false; }
  function finishRow() { finishField(); rows.push(row); row = []; if (rows.length > maxRows) throw new Error(maxRows === MAX_ROWS + 1 ? 'A base excede o limite de 5.000 linhas.' : 'O arquivo CSV excede o limite de linhas permitido.'); }
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inQuote) {
      if (character === '"') { if (text[index + 1] === '"') { field += '"'; index++; } else { inQuote = false; closedQuote = true; } }
      else field += character;
    } else if (character === '"') {
      if (field || closedQuote) throw new Error('Aspas inválidas no CSV. Exporte novamente em UTF-8.');
      inQuote = true;
    } else if (character === delimiter) finishField();
    else if (character === '\r' || character === '\n') { if (character === '\r' && text[index + 1] === '\n') index++; finishRow(); }
    else { if (closedQuote) throw new Error('Texto após aspas de fechamento no CSV.'); field += character; }
  }
  if (inQuote) throw new Error('CSV contém aspas sem fechamento.');
  if (field || row.length || closedQuote) finishRow();
  return rows;
}

export function inspectWorkbookZip(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) throw new Error('O arquivo não é uma planilha XLSX/XLSM válida.');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('Estrutura da planilha inválida.');
  const entries = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || entries > 256 || entries === 0 || start + size > end || start + size > bytes.length) throw new Error('Planilha multipartes, ZIP64 ou com quantidade excessiva de arquivos.');
  let offset = start, expanded = 0; const contents = [];
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Diretório da planilha inválido.');
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), compressed = view.getUint32(offset + 20, true), uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if ((flags & 1) || ![0, 8].includes(method) || uncompressed === 0xffffffff || compressed === 0xffffffff || localOffset === 0xffffffff || localOffset + 30 > start || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('Planilhas criptografadas ou ZIP64 não são aceitas.');
    const contentStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (contentStart + compressed > start || view.getUint16(localOffset + 8, true) !== method || (view.getUint16(localOffset + 6, true) & 1)) throw new Error('Conteúdo ZIP inconsistente.');
    contents.push({ start: contentStart, compressed, uncompressed, method });
    expanded += uncompressed;
    if (expanded > 20 * 1024 * 1024) throw new Error('Conteúdo expandido excede 20 MiB. Divida a base por uma origem completa autorizada.');
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > start + size) throw new Error('Planilha truncada.');
  }
  if (offset !== start + size) throw new Error('Diretório ZIP inconsistente.');
  return contents;
}

// Count actual output before ExcelJS allocates a workbook. A forged ZIP directory
// cannot bypass the expanded-size limit. The caller also terminates the worker.
export async function validateWorkbookExpandedSize(buffer) {
  const contents = inspectWorkbookZip(buffer);
  let total = 0;
  for (const content of contents) {
    let actual = 0;
    if (content.method === 0) { actual = content.compressed; total += actual; }
    else {
      const reader = new Blob([buffer.slice(content.start, content.start + content.compressed)]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          actual += chunk.value.byteLength; total += chunk.value.byteLength;
          if (actual > content.uncompressed || total > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('Conteúdo expandido excede o tamanho seguro declarado ou 20 MiB.'); }
        }
      } finally { reader.releaseLock(); }
    }
    if (total > 20 * 1024 * 1024 || actual !== content.uncompressed) throw new Error('Tamanho expandido da planilha é inconsistente ou excede 20 MiB.');
  }
}

function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && !(value instanceof Date)) {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('Fórmula não permitida. Salve uma cópia apenas com valores.');
    if ('richText' in value) return value.richText.map(part => part.text).join('');
    if ('text' in value && 'hyperlink' in value) return value.text;
    throw new Error('Célula com conteúdo não suportado. Use somente valores.');
  }
  if (typeof value === 'string' && /^\s*[=+@]/.test(value)) throw new Error('Conteúdo interpretável como fórmula. Salve somente valores.');
  return value;
}
const INVALID_CHEQUE = 'Número de cheque inválido. Use texto ou número inteiro não negativo, sem notação científica.';
const UNSUPPORTED_CHEQUE_FORMAT = 'Formato da célula do cheque não suportado. No Excel, formate o número do cheque como Texto ou use somente zeros, como 000000.';
function parseChequeNumber(value) {
  const primitive = scalar(value);
  if (typeof primitive === 'number') {
    if (!Number.isSafeInteger(primitive) || primitive < 0) throw new Error(INVALID_CHEQUE);
    return String(primitive);
  }
  if (typeof primitive !== 'string') throw new Error(INVALID_CHEQUE);
  const text = primitive.trim();
  if (text.length > 150) throw new Error('Limite de 150 caracteres excedido.');
  // Identifiers remain text, including leading zeros and punctuation. Do not
  // silently interpret decimal/scientific notation or accept control characters.
  if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)[eE][+-]?\d+$/.test(text) || /^-\d+(?:[.,]\d+)?$/.test(text) || /^\d+[.,]\d+$/.test(text) || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(INVALID_CHEQUE);
  return text;
}
export function isChequeNumberHeader(value) {
  return headerMap.get(normalize(scalar(value))) === 'cheque_number';
}
// ExcelJS cell.text does not apply custom numeric formats. Both workbook
// adapters use this function so 123 with format 000000 imports as "000123".
export function readPayableChequeCell(value, numFmt) {
  if (value instanceof Date) throw new Error(UNSUPPORTED_CHEQUE_FORMAT);
  const text = parseChequeNumber(value);
  if (typeof value !== 'number') return text;
  const format = String(numFmt ?? '').trim();
  if (!format || format.toUpperCase() === 'GENERAL' || format === '@') return text;
  if (!/^0+$/.test(format)) throw new Error(UNSUPPORTED_CHEQUE_FORMAT);
  if (format.length > 150) throw new Error('Limite de 150 caracteres excedido.');
  return text.padStart(format.length, '0');
}
export function validatePayableRows(matrix, { excel1904 = false } = {}) {
  const errors = [], rows = [];
  if (!matrix.length) return { rows, errors: [{ line: 1, column: 'Arquivo', problem: 'Arquivo vazio.', correction: 'Exporte o relatório completo com os cabeçalhos.' }] };
  const columns = new Map(), timestampColumns = new Set();
  matrix[0].forEach((value, index) => {
    let key;
    try {
      const normalizedHeader = normalize(scalar(value));
      key = headerMap.get(normalizedHeader);
      if (ERP_TIMESTAMP_HEADERS.has(normalizedHeader)) timestampColumns.add(index);
    } catch { errors.push({ line: 1, column: 'Cabeçalho', problem: 'Cabeçalho inválido.', correction: 'Use nomes de colunas sem fórmulas.' }); return; }
    if (key && columns.has(key)) errors.push({ line: 1, column: COLUMN_LABELS[key], problem: 'Coluna duplicada ou ambígua.', correction: 'Mantenha uma única coluna para este campo.' });
    else if (key) columns.set(key, index);
  });
  for (const key of REQUIRED) if (!columns.has(key)) errors.push({ line: 1, column: COLUMN_LABELS[key], problem: 'Coluna obrigatória ausente.', correction: `Inclua a coluna ${COLUMN_LABELS[key]}.` });
  if (errors.length) return { rows, errors };
  const keys = new Set(); let total = 0, nonempty = 0;
  for (let index = 1; index < matrix.length; index++) {
    const source = matrix[index];
    if (source.every(value => value === null || value === undefined || String(value).trim() === '')) continue;
    nonempty++;
    if (nonempty > MAX_ROWS) { errors.push({ line: index + 1, column: 'Arquivo', problem: 'Mais de 5.000 linhas.', correction: 'Exporte uma origem completa dentro do limite.' }); break; }
    const row = { entry_number: '', description: '', due_date: '', amount_cents: 0, plan: '', bank_account: '', branch: '', issued_on: null, source_status: '' };
    const before = errors.length;
    if (source.length > matrix[0].length && source.slice(matrix[0].length).some(value => value !== null && value !== undefined && String(value).trim())) errors.push({ line: index + 1, column: 'Arquivo', problem: 'Há valores fora das colunas do cabeçalho.', correction: 'Confira delimitadores e cabeçalhos; valores com vírgula em CSV devem estar entre aspas.' });
    source.forEach((value, column) => { if (!Array.from(columns.values()).includes(column)) { try { scalar(value); } catch (error) { errors.push({ line: index + 1, column: `Coluna ${column + 1}`, problem: error.message, correction: 'Salve uma cópia somente com valores, sem fórmulas.' }); } } });
    for (const [key, column] of columns) {
      try {
        const value = scalar(source[column]);
        if (key === 'amount_cents') row[key] = parseMoneyCents(value);
        else if (key === 'cheque_number') row[key] = parseChequeNumber(value);
        else if (key === 'due_date') row[key] = timestampColumns.has(column) ? parsePayableErpDate(value, excel1904) : parseCivilDate(value, excel1904);
        else if (key === 'issued_on') row[key] = String(value).trim() ? (timestampColumns.has(column) ? parsePayableErpDate(value, excel1904) : parseCivilDate(value, excel1904)) : null;
        else {
          row[key] = String(value ?? '').trim().replace(/\s+/g, ' ');
          if (REQUIRED.includes(key) && !row[key]) throw new Error('Campo obrigatório vazio.');
          const maximum = key === 'description' ? 1500 : ['entry_number','branch','source_status'].includes(key) ? 150 : 300;
          if (row[key].length > maximum) throw new Error(`Limite de ${maximum} caracteres excedido.`);
        }
      } catch (error) { errors.push({ line: index + 1, column: COLUMN_LABELS[key], problem: error.message, correction: 'Corrija a célula no arquivo original e selecione uma nova cópia.' }); }
    }
    // Stable across sorting and imports, never derived from worksheet row position.
    const identity = JSON.stringify([row.branch, row.entry_number, row.due_date, row.amount_cents]);
    if (errors.length === before && keys.has(identity)) errors.push({ line: index + 1, column: 'Nº lançamento', problem: 'Chave de título duplicada na mesma base.', correction: 'Confira filial, lançamento, vencimento e valor. Não remova duplicados sem validar a origem.' });
    if (errors.length === before) {
      total += row.amount_cents;
      if (!Number.isSafeInteger(total)) errors.push({ line: index + 1, column: 'Valor', problem: 'Total do relatório excede o limite de precisão.', correction: 'Confira valores e origem da base antes de importar.' });
      else { keys.add(identity); rows.push(row); }
    }
    if (errors.length >= 100) break;
  }
  if (!rows.length && !errors.length) errors.push({ line: 2, column: 'Arquivo', problem: 'Não há títulos no relatório.', correction: 'Selecione um relatório completo com lançamentos; base vazia não pode baixar títulos.' });
  return { rows: errors.length ? [] : rows, errors };
}

// This validator is selected only after the operator explicitly declares a
// paid-only report. An explicit payment-date column takes precedence. Only
// legacy reports without it use Vencimento as the user-confirmed payment date.
// Plano CC is the actual paying bank, as confirmed by the user.
// It never creates financial titles or derives payment facts from disappearance.
export function validatePayablePaidRows(matrix, { excel1904 = false, today, useExplicitPaymentDate = true, allowInternalCashWriteoff = false } = {}) {
  const errors = [], rows = [];
  if (today !== undefined) {
    try { if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today) || parseCivilDate(today) !== today) throw new Error('invalid-today'); }
    catch { return { rows, errors: [{ line: 0, column: 'Arquivo', problem: 'A data de referência da conferência é inválida.', correction: 'Atualize a página antes de analisar novamente.' }] }; }
  }
  if (!matrix.length) return { rows, errors: [{ line: 1, column: 'Arquivo', problem: 'Arquivo vazio.', correction: 'Exporte o relatório de pagamentos com os cabeçalhos.' }] };
  const columns = new Map(), timestampColumns = new Set();
  matrix[0].forEach((value, index) => {
    let key;
    try {
      const normalizedHeader = normalize(scalar(value));
      key = useExplicitPaymentDate !== false && PAID_DATE_HEADERS.has(normalizedHeader) ? 'paid_on' : headerMap.get(normalizedHeader);
      if (ERP_TIMESTAMP_HEADERS.has(normalizedHeader) || useExplicitPaymentDate !== false && PAID_TIMESTAMP_HEADERS.has(normalizedHeader)) timestampColumns.add(index);
    } catch { errors.push({ line: 1, column: 'Cabeçalho', problem: 'Cabeçalho inválido.', correction: 'Use nomes de colunas sem fórmulas.' }); return; }
    if (key && columns.has(key)) errors.push({ line: 1, column: PAID_COLUMN_LABELS[key], problem: 'Coluna duplicada ou ambígua.', correction: 'Mantenha uma única coluna para este campo.' });
    else if (key) columns.set(key, index);
  });
  const paymentDateKey = columns.has('paid_on') ? 'paid_on' : 'due_date';
  const required = ['entry_number', 'branch', paymentDateKey, 'amount_cents', 'bank_account'];
  for (const key of required) if (!columns.has(key)) errors.push({ line: 1, column: PAID_COLUMN_LABELS[key], problem: 'Coluna obrigatória ausente.', correction: `Inclua a coluna ${PAID_COLUMN_LABELS[key]}; não é possível deduzir dados do pagamento.` });
  if (errors.length) return { rows, errors };
  const used = new Set([...required, 'source_status', 'cheque_number', 'description', 'plan', 'issued_on']);
  const usedColumns = new Set([...columns].filter(([key]) => used.has(key)).map(([, column]) => column));
  const identities = new Set(); let total = 0, nonempty = 0;
  for (let index = 1; index < matrix.length; index++) {
    const source = matrix[index];
    if (source.every(value => value === null || value === undefined || String(value).trim() === '')) continue;
    nonempty++;
    if (nonempty > MAX_ROWS) { errors.push({ line: index + 1, column: 'Arquivo', problem: 'Mais de 5.000 linhas.', correction: 'Exporte uma origem completa dentro do limite.' }); break; }
    // The bank can occur after the date column. Classify its source value
    // independently of header order; the regular loop still validates it.
    let internalCash = false;
    if (allowInternalCashWriteoff === true) {
      try { internalCash = isInternalCashBank(scalar(source[columns.get('bank_account')])); }
      catch { /* The bank validation below reports unsupported content. */ }
    }
    const row = { branch: '', entry_number: '', source_status: 'PAGO', paid_on: internalCash ? null : '', amount_paid_cents: 0, paid_bank: '' };
    const before = errors.length;
    if (source.length > matrix[0].length && source.slice(matrix[0].length).some(value => value !== null && value !== undefined && String(value).trim())) errors.push({ line: index + 1, column: 'Arquivo', problem: 'Há valores fora das colunas do cabeçalho.', correction: 'Confira delimitadores e cabeçalhos; valores com vírgula em CSV devem estar entre aspas.' });
    source.forEach((value, column) => { if (!usedColumns.has(column)) { try { scalar(value); } catch (error) { errors.push({ line: index + 1, column: `Coluna ${column + 1}`, problem: error.message, correction: 'Salve uma cópia somente com valores, sem fórmulas.' }); } } });
    for (const [key, column] of columns) {
      if (!used.has(key)) continue;
      try {
        const value = scalar(source[column]);
        if (key === 'amount_cents') {
          row.amount_paid_cents = parseMoneyCents(value);
          if (row.amount_paid_cents <= 0) throw new Error('O valor pago deve ser maior que zero.');
        } else if (key === paymentDateKey) {
          if (internalCash) row.paid_on = null;
          else {
            row.paid_on = timestampColumns.has(column) ? parsePayableErpDate(value, excel1904) : parseCivilDate(value, excel1904);
            if (today !== undefined && row.paid_on > today) throw new Error('A data do pagamento é futura.');
          }
        } else if (key === 'cheque_number') row.cheque_number = parseChequeNumber(value);
        else if (key === 'issued_on') row.issued_on = String(value).trim() ? (timestampColumns.has(column) ? parsePayableErpDate(value, excel1904) : parseCivilDate(value, excel1904)) : null;
        else {
          const text = String(value ?? '').trim().replace(/\s+/g, ' ');
          if (key === 'source_status') {
            if (!['', 'PAGO', 'CHEQUE', 'QUITADO', 'LIQUIDADO', 'COMPENSADO'].includes(text.toUpperCase())) throw new Error('O relatório de pagamentos contém situação incompatível com pagamento confirmado.');
          } else if (key === 'description' || key === 'plan') {
            const maximum = key === 'description' ? 1500 : 300;
            if (text.length > maximum) throw new Error(`Limite de ${maximum} caracteres excedido.`);
            // Paid reports can carry current ERP metadata. Empty optional text
            // does not erase a known title description or accounting plan.
            if (text) row[key] = text;
          } else {
            if (!text) throw new Error('Campo obrigatório vazio.');
            const maximum = key === 'bank_account' ? 300 : 150;
            if (text.length > maximum) throw new Error(`Limite de ${maximum} caracteres excedido.`);
            if (key === 'bank_account') row.paid_bank = text;
            else row[key] = text;
          }
        }
      } catch (error) { errors.push({ line: index + 1, column: PAID_COLUMN_LABELS[key], problem: error.message, correction: error.message === 'A data do pagamento é futura.' ? 'Confira a data efetiva no sistema de origem; pagamentos agendados não confirmam pagamento realizado.' : 'Confira o comprovante e corrija o relatório de pagamentos; não use datas ou bancos previstos.' }); }
    }
    // One integral payment per stable title identity. Sorting, payment date,
    // amount and bank never create a second title identity in this report.
    const identity = JSON.stringify([row.branch.toUpperCase(), row.entry_number.toUpperCase()]);
    if (errors.length === before && identities.has(identity)) errors.push({ line: index + 1, column: 'Nº lançamento', problem: 'Lançamento repetido no relatório de pagamentos.', correction: 'Mantenha um único pagamento integral por filial e número de lançamento.' });
    if (errors.length === before) {
      total += row.amount_paid_cents;
      if (!Number.isSafeInteger(total)) errors.push({ line: index + 1, column: 'Valor', problem: 'Total do relatório excede o limite de precisão.', correction: 'Confira valores e origem da base antes de importar.' });
      else { identities.add(identity); rows.push(row); }
    }
    if (errors.length >= 100) break;
  }
  if (!rows.length && !errors.length) errors.push({ line: 2, column: 'Arquivo', problem: 'Não há títulos no relatório.', correction: 'Selecione o relatório de pagamentos com lançamentos; nenhum pagamento será deduzido de uma base vazia.' });
  return { rows: errors.length ? [] : rows, errors };
}
