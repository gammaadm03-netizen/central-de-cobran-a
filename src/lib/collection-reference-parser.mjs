// Nonfinancial reference files. The server independently parses each raw CSV
// artifact; XLSX conversion below runs only in the browser worker (or tests).
export const REFERENCE_LIMITS = Object.freeze({ fileBytes: 16 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024, sharedStringBytes: 14 * 1024 * 1024, rows: 300000, chunkRows: 500, chunkBytes: 256 * 1024, entries: 256, cellBytes: 128 * 1024 });
export const REFERENCE_HEADERS = Object.freeze({ contacts: ['Entidade: nome', 'Endereço: email', 'T. 1: ddd', 'T. 1: número'], descriptions: ['CLIENTE', 'CONTRATO', 'NOTA FISCAL', 'DESCRIÇÃO', 'FILIAL'] });
const utf8 = new TextEncoder();
const fail = (message) => { throw new Error(message); };
const abortCheck = (signal) => { if (signal?.aborted) throw new DOMException('Importação cancelada.', 'AbortError'); };
const modeHeaders = (mode) => REFERENCE_HEADERS[mode] ?? fail('Tipo de referência inválido.');
const headerMatches = (value, expected) => value === expected || (expected === 'T. 1: ddd' && value === 'T.1: ddd') || (expected === 'T. 1: número' && value === 'T.1: número');
const clean = (value) => String(value ?? '').trim();
const clientText = (value) => clean(value).replace(/\s+/gu, ' ');
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
export function referenceCsvRow(cells) { return cells.map(csvCell).join(';') + '\r\n'; }
// Use only for a human spreadsheet export, never for the raw conversion artifact.
export function safeReferenceExportCell(value) { const text = String(value ?? ''); return csvCell(/^[\s]*[=+@-]/u.test(text) ? `'${text}` : text); }

function csvMatrix(text) {
  const rows = []; let row = [], value = '', quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (char === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; afterQuote = true; } } else value += char; continue; }
    if (afterQuote && char !== ';' && char !== '\r' && char !== '\n') fail('CSV inválido: texto após aspas.');
    if (char === '"') { if (value || afterQuote) fail('CSV inválido: aspas fora do início do campo.'); quoted = true; }
    else if (char === ';') { row.push(value); value = ''; afterQuote = false; }
    else if (char === '\r' || char === '\n') { if (char === '\r' && text[i + 1] === '\n') i++; row.push(value); rows.push(row); row = []; value = ''; afterQuote = false; }
    else value += char;
    if (rows.length > REFERENCE_LIMITS.chunkRows + 1) fail('O trecho CSV ultrapassa 500 linhas.');
  }
  if (quoted) fail('CSV inválido: aspas não finalizadas.');
  if (value || row.length || afterQuote) { row.push(value); rows.push(row); }
  return rows;
}

function emailValid(value) {
  if (value.length > 320 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value)) return false;
  const [local, domain] = value.split('@');
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') && domain.split('.').every((part) => part.length > 0 && part.length <= 63 && !part.startsWith('-') && !part.endsWith('-'));
}
const absent = (value) => /^(?:\s*|[-–—.]+|n[ãa]o\s+(?:tem|possui|informado)|sem\s+(?:e-?mail|telefone|contato)|n\/?a|null|undefined)$/iu.test(value);

/** CSV shape/cap errors throw; source content problems remain private row issues. */
export function parseReferenceCsv(input, mode) {
  const headers = modeHeaders(mode);
  const bytes = typeof input === 'string' ? utf8.encode(input) : input;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > REFERENCE_LIMITS.chunkBytes) fail('Trecho CSV inválido ou maior que 256 KiB.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); } catch { fail('CSV deve usar UTF-8 válido.'); }
  const matrix = csvMatrix(text);
  if (matrix.length < 2 || matrix.length > REFERENCE_LIMITS.chunkRows + 1) fail('O trecho CSV deve conter de 1 a 500 linhas.');
  const expected = ['source_line', ...headers];
  if (matrix[0].length !== expected.length || matrix[0].some((value, index) => !headerMatches(value, expected[index]))) fail('Cabeçalho CSV de referência inválido.');
  const rows = [], problems = [], sourceLines = new Set();
  for (const cells of matrix.slice(1)) {
    if (cells.length !== expected.length) fail('CSV contém quantidade inesperada de colunas.');
    if (!/^[1-9]\d{0,6}$/.test(cells[0]) || Number(cells[0]) > 1000000 || sourceLines.has(Number(cells[0]))) fail('Linha de origem inválida ou repetida no trecho CSV.');
    const source_line = Number(cells[0]); sourceLines.add(source_line);
    const issue = (code, field, message) => problems.push({ source_line, code, field, message });
    const bounded = (value, length, field) => { if (value.length <= length && !/[\u0000\u000B\u000C]/u.test(value)) return value; issue('FIELD_TOO_LONG', field, 'O campo excede o limite ou contém caracteres de controle.'); return ''; };
    const client_name = bounded(clientText(cells[1]), 1500, 'client_name');
    if (!client_name) issue('MISSING_CLIENT', 'client_name', 'Nome do cliente ausente.');
    if (mode === 'contacts') {
      const emailSource = clean(cells[2]); let emails = [];
      if (!absent(emailSource)) {
        const tokens = emailSource.split(/[;,\s]+/u).filter(Boolean);
        let invalid = false;
        for (let token of tokens) { token = token.replace(/^<|>$/g, '').toLowerCase(); if (emailValid(token)) emails.push(token); else invalid = true; }
        if (invalid) issue('WARN_INVALID_EMAIL', 'emails', 'Há e-mails não reconhecidos; apenas endereços com formato válido serão considerados.');
      }
      emails = [...new Set(emails)];
      const dddRaw = clean(cells[3]), phoneRaw = clean(cells[4]); let phones = [];
      if (!absent(dddRaw) || !absent(phoneRaw)) {
        const ddd = dddRaw.replace(/[()\s]/g, ''); let invalid = !/^[1-9]\d$/.test(ddd);
        const tokens = phoneRaw.split(/[;,/\n]+/u).filter((value) => clean(value));
        if (!tokens.length) invalid = true;
        for (const token of tokens) { const digits = token.replace(/[()\s.\-]/g, ''); if (/^[1-9]\d$/.test(ddd) && /^\d{8,9}$/.test(digits)) phones.push(ddd + digits); else invalid = true; }
        if (invalid) issue('WARN_INVALID_PHONE', 'phones', 'Há telefones sem DDD e número válidos; nenhum canal WhatsApp é presumido.');
      }
      phones = [...new Set(phones)];
      if (emails.length > 50 || phones.length > 50) { issue('LIMIT_METHODS', 'contacts', 'O cliente excede o limite de canais por linha.'); emails = emails.slice(0, 50); phones = phones.slice(0, 50); }
      if (!emails.length && !phones.length) issue('MISSING_CONTACT', 'contacts', 'A linha não possui e-mail ou telefone com formato válido.');
      rows.push({ source_line, client_name, client_document: null, emails, phones, notes: null });
    } else {
      const contract = bounded(clean(cells[2]), 300, 'contract') || null;
      const document = bounded(clean(cells[3]), 150, 'document');
      const description = bounded(clean(cells[4]).replace(/\r\n?/g, '\n'), 12000, 'description');
      const branch = bounded(clean(cells[5]), 150, 'branch');
      if (!document) issue('MISSING_DOCUMENT', 'document', 'Número do documento ausente.');
      if (!description) issue('MISSING_DESCRIPTION', 'description', 'Descrição ausente.');
      if (!/^\d+$/u.test(branch) || !/[1-9]/.test(branch)) issue('INVALID_BRANCH', 'branch', 'A filial deve ser um código inteiro positivo.');
      rows.push({ source_line, document, branch, client_name, client_document: null, description, contract });
    }
  }
  const quarantined = new Set(problems.filter((problem) => !problem.code.startsWith('WARN_')).map((problem) => problem.source_line));
  return { rows, problems, stats: { rows: rows.length, problem_count: problems.length, warning_count: problems.filter((problem) => problem.code.startsWith('WARN_')).length, quarantined_rows: quarantined.size } };
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let value = i; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; crcTable[i] = value >>> 0; }
function crcUpdate(crc, bytes) { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc >>> 0; }
const little = (view, offset, length = 4) => length === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true);
const decodeUtf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/** Strict central directory inspection; no extraction to disk and no ZIP64. */
export function inspectReferenceZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22 || bytes.byteLength > REFERENCE_LIMITS.fileBytes) fail('Arquivo XLSX inválido ou maior que 16 MiB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let eocd = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos--) if (little(view, pos) === 0x06054b50 && pos + 22 + little(view, pos + 20, 2) === bytes.length) { eocd = pos; break; }
  if (eocd < 0) fail('Diretório ZIP não encontrado.');
  const count = little(view, eocd + 10, 2), size = little(view, eocd + 12), start = little(view, eocd + 16);
  if (little(view, eocd + 4, 2) || little(view, eocd + 6, 2) || little(view, eocd + 8, 2) !== count || count > REFERENCE_LIMITS.entries || count === 0 || start + size !== eocd) fail('ZIP multidisco, ZIP64 ou diretório inválido.');
  const entries = new Map(), ranges = []; let pos = start, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (pos + 46 > eocd || little(view, pos) !== 0x02014b50) fail('Entrada ZIP inválida.');
    const flags = little(view, pos + 8, 2), method = little(view, pos + 10, 2), crc = little(view, pos + 16), compressed = little(view, pos + 20), uncompressed = little(view, pos + 24);
    const nameLength = little(view, pos + 28, 2), extraLength = little(view, pos + 30, 2), commentLength = little(view, pos + 32, 2), local = little(view, pos + 42);
    if (pos + 46 + nameLength + extraLength + commentLength > eocd || [compressed, uncompressed, local].includes(0xffffffff) || little(view, pos + 34, 2)) fail('ZIP64 ou entrada truncada.');
    let name; try { name = decodeUtf8(bytes.subarray(pos + 46, pos + 46 + nameLength)); } catch { fail('Nome ZIP inválido.'); }
    if (!name || name.includes('\\') || name.includes('\u0000') || name.startsWith('/') || name.split('/').some((part) => part === '..' || part === '.') || entries.has(name)) fail('Caminho ZIP inválido ou repetido.');
    if ((flags & ~0x080e) || (flags & 1) || ![0, 8].includes(method) || (method === 0 && compressed !== uncompressed) || (little(view, pos + 38) >>> 16 & 0xf000) === 0xa000) fail('ZIP criptografado ou método não suportado.');
    for (let extra = pos + 46 + nameLength, end = extra + extraLength; extra < end;) { if (extra + 4 > end) fail('Extra ZIP inválido.'); const tag = little(view, extra, 2), len = little(view, extra + 2, 2); if (tag === 1 || extra + 4 + len > end) fail('ZIP64 ou extra ZIP inválido.'); extra += 4 + len; }
    if (local + 30 > start || little(view, local) !== 0x04034b50 || little(view, local + 6, 2) !== flags || little(view, local + 8, 2) !== method) fail('Cabeçalho local ZIP inválido.');
    const localName = little(view, local + 26, 2), localExtra = little(view, local + 28, 2), dataStart = local + 30 + localName + localExtra;
    if (dataStart + compressed > start || decodeUtf8(bytes.subarray(local + 30, local + 30 + localName)) !== name) fail('Conteúdo ZIP sobreposto ou truncado.');
    if (!(flags & 8) && (little(view, local + 14) !== crc || little(view, local + 18) !== compressed || little(view, local + 22) !== uncompressed)) fail('Tamanhos ZIP divergentes.');
    expanded += uncompressed;
    if (expanded > REFERENCE_LIMITS.expandedBytes) fail('O arquivo expandido ultrapassa 128 MiB.');
    entries.set(name, { name, method, crc, compressed, uncompressed, dataStart }); ranges.push([local, dataStart + compressed]);
    pos += 46 + nameLength + extraLength + commentLength;
  }
  if (pos !== eocd) fail('Diretório ZIP contém bytes inesperados.');
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) fail('Entradas ZIP sobrepostas.');
  return entries;
}

async function* entryBytes(bytes, entry, signal) {
  abortCheck(signal);
  if (!entry) fail('Parte obrigatória do XLSX não encontrada.');
  let stream = new Blob([bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed)]).stream();
  if (entry.method === 8) {
    if (typeof DecompressionStream === 'undefined') fail('Este navegador não oferece descompactação segura. Atualize o navegador.');
    try { stream = stream.pipeThrough(new DecompressionStream('deflate-raw')); } catch { fail('Este navegador não oferece descompactação segura. Atualize o navegador.'); }
  }
  const reader = stream.getReader(); let length = 0, crc = 0xffffffff;
  try {
    for (;;) { abortCheck(signal); const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > entry.uncompressed || length > REFERENCE_LIMITS.expandedBytes) fail('Tamanho expandido ZIP inválido.'); crc = crcUpdate(crc, value); yield value; }
    if (length !== entry.uncompressed || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail('Integridade CRC ou tamanho ZIP inválido.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function xmlSafe(value) { if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(value)) fail('XML com DTD ou entidades personalizadas não é permitido.'); }
function xmlText(value) {
  xmlSafe(value);
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/iu.test(value)) fail('Entidade XML inválida ou não permitida.');
  return value.replace(/&([^;]{1,32});/gu, (_, entity) => {
    if (entity === 'amp') return '&'; if (entity === 'lt') return '<'; if (entity === 'gt') return '>'; if (entity === 'quot') return '"'; if (entity === 'apos') return "'";
    let cp; if (/^#\d+$/.test(entity)) cp = Number(entity.slice(1)); else if (/^#x[0-9a-f]+$/iu.test(entity)) cp = Number.parseInt(entity.slice(2), 16); else fail('Entidade XML não permitida.');
    if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('Caractere XML inválido.');
    return String.fromCodePoint(cp);
  });
}
function attrs(tag) { const result = {}; for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) result[match[1]] = xmlText(match[2] ?? match[3]); return result; }
async function entryText(bytes, entry, signal, cap = 2 * 1024 * 1024) {
  if (entry?.uncompressed > cap) fail('Metadados XLSX excedem o limite seguro.');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '';
  for await (const chunk of entryBytes(bytes, entry, signal)) { text += decoder.decode(chunk, { stream: true }); xmlSafe(text); }
  text += decoder.decode(); xmlSafe(text); return text;
}

/** Extract one bounded XML element at a time, retaining no worksheet graph. */
async function* elements(bytes, entry, localName, signal, cap) {
  const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '', scanTail = '';
  const opening = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${localName}(?=[\\s/>])`, 'u');
  const closing = new RegExp(`</(?:(?:[A-Za-z_][\\w.-]*):)?${localName}\\s*>`, 'u');
  async function* consume(final) {
    for (;;) {
      const start = opening.exec(buffer);
      if (!start) { if (final) buffer = ''; else if (buffer.length > 128) buffer = buffer.slice(-128); return; }
      if (start.index > 0) buffer = buffer.slice(start.index);
      const openEnd = buffer.indexOf('>'); if (openEnd < 0) { if (buffer.length > cap) fail('Elemento XML excede o limite seguro.'); return; }
      let end;
      if (buffer[openEnd - 1] === '/') end = openEnd + 1;
      else { const close = closing.exec(buffer.slice(openEnd + 1)); if (close) end = openEnd + 1 + close.index + close[0].length; }
      if (end === undefined) { if (buffer.length > cap || final) fail('Elemento XML truncado ou muito grande.'); return; }
      if (end > cap) fail('Elemento XML excede o limite seguro.');
      const token = buffer.slice(0, end); buffer = buffer.slice(end); yield token;
    }
  }
  for await (const chunk of entryBytes(bytes, entry, signal)) {
    const text = decoder.decode(chunk, { stream: true }); xmlSafe(scanTail + text); scanTail = text.slice(-64); buffer += text;
    yield* consume(false);
  }
  const text = decoder.decode(); xmlSafe(scanTail + text); buffer += text; yield* consume(true);
}
function textRuns(xml) {
  let result = '';
  const withoutPhonetics = xml.replace(/<(?:\w+:)?rPh\b[^>]*>[\s\S]*?<\/(?:\w+:)?rPh\s*>/gu, '');
  for (const match of withoutPhonetics.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t\s*>/gu)) result += xmlText(match[1]);
  return result;
}
function columnIndex(ref) { const match = /^([A-Z]+)[1-9]\d*$/u.exec(ref ?? ''); if (!match) fail('Referência de célula XLSX inválida.'); let col = 0; for (const char of match[1]) col = col * 26 + char.charCodeAt(0) - 64; if (col > 64) fail('A planilha excede o limite de 64 colunas.'); return col - 1; }
function exactInteger(raw) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[Ee]([+-]?\d+))?$/u.exec(raw);
  if (!match) return raw;
  const exponent = Number(match[4] ?? 0); if (!Number.isInteger(exponent) || Math.abs(exponent) > 150) return raw;
  let digits = match[2] + (match[3] ?? ''), scale = (match[3]?.length ?? 0) - exponent;
  if (scale > 0) { if (scale > digits.length || !/^0*$/u.test(digits.slice(-scale))) return raw; digits = digits.slice(0, -scale) || '0'; }
  else if (scale < 0) digits += '0'.repeat(-scale);
  digits = digits.replace(/^0+(?=\d)/u, '');
  return (match[1] === '-' && digits !== '0' ? '-' : '') + digits;
}
function numberText(raw, style, formats) {
  const value = exactInteger(raw); const format = formats[style] ?? 'General';
  if (/^\d+$/u.test(value) && /^0{2,150}$/u.test(format)) return value.padStart(format.length, '0');
  return value;
}
function parseStyles(xml) {
  const custom = new Map();
  for (const match of xml.matchAll(/<(?:\w+:)?numFmt\b[^>]*\/?\s*>/gu)) { const a = attrs(match[0]); custom.set(a.numFmtId, a.formatCode); }
  const section = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs\s*>/u.exec(xml)?.[1] ?? '';
  const formats = [];
  for (const match of section.matchAll(/<(?:\w+:)?xf\b[^>]*>/gu)) { const a = attrs(match[0]); formats.push(custom.get(a.numFmtId) ?? (a.numFmtId === '1' ? '0' : 'General')); }
  return formats;
}
function rowCells(xml, shared, formats, previousLine) {
  const a = attrs(xml.slice(0, xml.indexOf('>') + 1)), line = Number(a.r);
  if (!Number.isInteger(line) || line <= previousLine || line > 1000000) fail('Linhas físicas XLSX inválidas ou fora de ordem.');
  if (/<(?:\w+:)?f(?=[\s/>])/u.test(xml)) fail(`A linha ${line} contém fórmula. Converta fórmulas em valores antes de importar.`);
  const cells = []; const occupied = new Set();
  for (const match of xml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c\s*>)/gu)) {
    const c = attrs(match[1]), index = columnIndex(c.r);
    if (occupied.has(index) || Number(c.r.match(/\d+$/u)?.[0]) !== line) fail('Células XLSX repetidas ou com linha divergente.'); occupied.add(index);
    const inner = match[2] ?? '', v = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v\s*>/u.exec(inner)?.[1] ?? '';
    let value;
    if (c.t === 's') { if (!/^\d+$/u.test(v) || Number(v) >= shared.length) fail('Índice sharedStrings inválido.'); value = shared[Number(v)]; }
    else if (c.t === 'inlineStr') value = textRuns(inner);
    else if (c.t === 'str' || c.t === 'e' || c.t === 'b') value = xmlText(v);
    else if (!c.t || c.t === 'n') value = numberText(xmlText(v), Number(c.s ?? 0), formats);
    else fail('Tipo de célula XLSX não suportado.');
    if (utf8.encode(value).length > REFERENCE_LIMITS.cellBytes) fail(`A linha ${line} contém uma célula muito grande.`);
    cells[index] = value;
  }
  return { line, cells };
}
export async function referenceSha256(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join(''); }

/** Browser-worker/Node streaming conversion. Awaiting onChunk is the backpressure. */
export async function streamReferenceWorkbook(bytes, mode, options) {
  const headers = modeHeaders(mode); if (typeof options?.onChunk !== 'function') fail('Destino dos trechos CSV não informado.');
  const signal = options.signal; abortCheck(signal); const entries = inspectReferenceZip(bytes), readEntries = new Set();
  const readText = async (name) => { const entry = entries.get(name); if (!entry) fail('Estrutura XLSX incompleta.'); readEntries.add(name); return entryText(bytes, entry, signal); };
  const workbook = await readText('xl/workbook.xml'), rels = await readText('xl/_rels/workbook.xml.rels');
  const sheets = [...workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/gu)].map((match) => attrs(match[0]));
  if (sheets.length !== 1) fail('A referência deve conter uma única planilha.');
  const relations = [...rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/gu)].map((match) => attrs(match[0]));
  const sheetRelation = relations.find((rel) => rel.Id === sheets[0]['r:id']);
  if (!sheetRelation || sheetRelation.TargetMode === 'External' || !/\/worksheet$/u.test(sheetRelation.Type ?? '')) fail('Relação da planilha XLSX inválida.');
  const target = sheetRelation.Target.startsWith('/') ? sheetRelation.Target.slice(1) : `xl/${sheetRelation.Target}`;
  if (!entries.has(target) || target.split('/').some((part) => part === '..' || part === '.')) fail('Caminho da planilha XLSX inválido.');
  const formats = entries.has('xl/styles.xml') ? parseStyles(await readText('xl/styles.xml')) : [];
  const shared = []; let sharedBytes = 0;
  if (entries.has('xl/sharedStrings.xml')) {
    readEntries.add('xl/sharedStrings.xml');
    for await (const item of elements(bytes, entries.get('xl/sharedStrings.xml'), 'si', signal, REFERENCE_LIMITS.cellBytes * 2)) {
      const value = textRuns(item); sharedBytes += utf8.encode(value).length;
      if (sharedBytes > REFERENCE_LIMITS.sharedStringBytes || shared.length >= 500000) fail('O cache de textos XLSX ultrapassa o limite seguro de 14 MiB.'); shared.push(value);
    }
  }
  const stats = { source_rows: 0, nonblank_rows: 0, blank_rows: 0, duplicate_rows: 0, emitted_rows: 0, chunk_count: 0, problem_count: 0, warning_count: 0, quarantined_rows: 0, source_line_max: 0, header_source_line: 0, extra_column_rows: 0, extra_cells: 0, shared_string_bytes: sharedBytes };
  const seen = new Set(); let previousLine = 0, headerSeen = false, pending = [], csvParts = [], csvSize = 0, chunkLines = [];
  const csvHeader = referenceCsvRow(['source_line', ...headers]);
  const flushChunk = async () => {
    if (!chunkLines.length) return;
    abortCheck(signal); const csv = utf8.encode(csvHeader + csvParts.join(''));
    const result = parseReferenceCsv(csv, mode); stats.problem_count += result.stats.problem_count; stats.warning_count += result.stats.warning_count; stats.quarantined_rows += result.stats.quarantined_rows;
    const chunk = { sequence: stats.chunk_count, csv, sha256: await referenceSha256(csv), rowCount: chunkLines.length, firstSourceLine: chunkLines[0], lastSourceLine: chunkLines.at(-1) };
    await options.onChunk(chunk); abortCheck(signal); stats.chunk_count++; csvParts = []; chunkLines = []; csvSize = 0;
    options.onProgress?.({ phase: 'rows', ...stats });
  };
  const flushPending = async () => {
    const batch = pending; pending = [];
    const hashes = await Promise.all(batch.map(({ raw }) => referenceSha256(utf8.encode(JSON.stringify(raw)))));
    for (let i = 0; i < batch.length; i++) {
      abortCheck(signal); const { raw, line } = batch[i], hash = hashes[i];
      if (seen.has(hash)) { stats.duplicate_rows++; continue; } seen.add(hash);
      const csvRow = referenceCsvRow([line, ...raw]), rowSize = utf8.encode(csvRow).length;
      if (rowSize + utf8.encode(csvHeader).length > REFERENCE_LIMITS.chunkBytes) fail(`A linha ${line} não cabe em um trecho seguro de 256 KiB.`);
      if (chunkLines.length >= REFERENCE_LIMITS.chunkRows || csvSize + rowSize + utf8.encode(csvHeader).length > REFERENCE_LIMITS.chunkBytes) await flushChunk();
      csvParts.push(csvRow); csvSize += rowSize; chunkLines.push(line); stats.emitted_rows++;
    }
  };
  readEntries.add(target);
  for await (const xmlRow of elements(bytes, entries.get(target), 'row', signal, REFERENCE_LIMITS.chunkBytes * 2)) {
    abortCheck(signal); const { line, cells } = rowCells(xmlRow, shared, formats, previousLine); previousLine = line;
    const raw = headers.map((_, index) => cells[index] ?? ''), nonblank = cells.some((value) => clean(value));
    if (!headerSeen) { if (!nonblank) continue; if (raw.some((value, index) => !headerMatches(clean(value).replace(/^\uFEFF/u, ''), headers[index])) || cells.slice(headers.length).some((value) => clean(value))) fail('Cabeçalho XLSX diferente das colunas oficiais desta referência.'); headerSeen = true; stats.header_source_line = line; continue; }
    stats.source_rows++; stats.source_line_max = line;
    if (stats.source_rows > REFERENCE_LIMITS.rows) fail('A referência ultrapassa 300.000 linhas de origem.');
    if (!nonblank) { stats.blank_rows++; continue; } stats.nonblank_rows++;
    const extras = cells.slice(headers.length).filter((value) => clean(value));
    if (extras.length) {
      stats.extra_column_rows++; stats.extra_cells += extras.length;
      // Unknown columns may only be omitted from the derived artifact when the
      // independently parsed official fields already quarantine this same row.
      const probe = parseReferenceCsv(csvHeader + referenceCsvRow([line, ...raw]), mode);
      if (!probe.stats.quarantined_rows) fail(`A linha ${line} contém dados fora das colunas oficiais. Confira o arquivo original.`);
    }
    pending.push({ raw, line }); if (pending.length >= 64) await flushPending();
  }
  if (!headerSeen || !stats.nonblank_rows) fail('A planilha não contém linhas de referência.');
  await flushPending(); await flushChunk();
  // Validate integrity even for unused ZIP parts without constructing objects.
  for (const [name, entry] of entries) if (!readEntries.has(name)) {
    const decoder = /\.(?:xml|rels)$/iu.test(name) ? new TextDecoder('utf-8', { fatal: true }) : null; let tail = '';
    for await (const chunk of entryBytes(bytes, entry, signal)) if (decoder) { const text = decoder.decode(chunk, { stream: true }); xmlSafe(tail + text); tail = text.slice(-64); }
    if (decoder) xmlSafe(tail + decoder.decode());
  }
  abortCheck(signal); const sourceSha256 = await referenceSha256(bytes);
  options.onProgress?.({ phase: 'complete', ...stats });
  return { sourceSha256, stats };
}
