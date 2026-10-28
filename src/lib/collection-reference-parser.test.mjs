import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseReferenceCsv, streamReferenceWorkbook, inspectReferenceZip, REFERENCE_HEADERS, REFERENCE_CONTACT_REPORT_HEADERS, REFERENCE_LIMITS, referenceCsvRow, referenceSha256, safeReferenceExportCell } from './collection-reference-parser.mjs';

const encode = (text) => new TextEncoder().encode(text);
const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function zip(parts, options = {}) {
  const locals = [], directories = []; let offset = 0;
  for (const [name, value] of parts) {
    const body = encode(value), filename = encode(name), compressed = deflateRawSync(body), crc = crc32(body), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(body.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(header, filename, compressed); directories.push(directory, filename); offset += header.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directories), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  const result = new Uint8Array(Buffer.concat([...locals, central, end]));
  if (options.modify) options.modify(result, offset);
  return result;
}
function row(line, values) { return `<row r="${line}">${values.map((value, index) => value === null ? '' : typeof value === 'object' ? `<c r="${String.fromCharCode(65 + index)}${line}" ${value.attributes ?? ''}>${value.inner}</c>` : `<c r="${String.fromCharCode(65 + index)}${line}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`; }
function workbook(mode, rows, options = {}) {
  const sheet = `<worksheet><sheetData>${row(1, options.headers ?? REFERENCE_HEADERS[mode])}${rows.join('')}</sheetData></worksheet>`;
  const parts = [
    ['xl/workbook.xml', options.workbook ?? '<workbook xmlns:r="urn:relationships"><sheets><sheet name="Referências" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', options.sheet ?? sheet],
    ...(options.parts ?? []),
  ];
  return zip(parts, options);
}
const csv = (mode, rows) => referenceCsvRow(['source_line', ...REFERENCE_HEADERS[mode]]) + rows.map(referenceCsvRow).join('');
const contactReportCsv = (rows) => referenceCsvRow(['source_line', ...REFERENCE_CONTACT_REPORT_HEADERS]) + rows.map(referenceCsvRow).join('');
async function convert(bytes, mode, options = {}) { const chunks = []; const result = await streamReferenceWorkbook(bytes, mode, { ...options, onChunk: async chunk => { chunks.push(chunk); await options.onChunk?.(chunk); } }); return { ...result, chunks }; }

test('server CSV parser preserves literal fields, quoted lines and optional contracts without inventing identifiers', () => {
  const parsed = parseReferenceCsv(csv('descriptions', [[27, 'Órgão  Á', '', '0000123', 'Linha; "um"\n=texto literal & dados', '014']]), 'descriptions');
  assert.deepEqual(parsed.rows[0], { source_line: 27, client_name: 'Órgão Á', client_document: null, document: '0000123', branch: '014', description: 'Linha; "um"\n=texto literal & dados', contract: null });
  assert.deepEqual(parsed.problems, []);
  assert.equal(safeReferenceExportCell('=literal'), '"\'=literal"');
  assert.match(csv('descriptions', [[2, 'Cliente', '', '1', '=literal', '99']]), /"=literal"/);
});
test('contact methods union exact valid addresses and explicit DDD phones, reporting invalid alternatives', () => {
  const parsed = parseReferenceCsv(csv('contacts', [[2, ' Cliente  Um ', 'a@example.com; B@example.org, a@example.com inválido', '(21)', '99999-8888 / 2345-6789']]), 'contacts');
  assert.deepEqual(parsed.rows[0].emails, ['a@example.com', 'b@example.org']); assert.deepEqual(parsed.rows[0].phones, ['21999998888', '2123456789']);
  assert.equal(parsed.rows[0].client_name, 'Cliente Um'); assert.equal(parsed.rows[0].notes, null); assert.equal(parsed.rows[0].client_document, null);
  assert.deepEqual(parsed.problems.map(problem => problem.code), ['WARN_INVALID_EMAIL']); assert.equal(parsed.stats.quarantined_rows, 0);
});
test('nameless and channel-less nonblank rows remain independently quarantinable', () => {
  const parsed = parseReferenceCsv(csv('contacts', [[6, '', 'não tem', '', ''], [7, 'Cliente', 'errado', '', '21999998888']]), 'contacts');
  assert.equal(parsed.rows.length, 2); assert.equal(parsed.stats.quarantined_rows, 2); assert.deepEqual(parsed.rows[1].phones, []);
  assert(parsed.problems.some(problem => problem.source_line === 6 && problem.code === 'MISSING_CLIENT'));
  assert(parsed.problems.some(problem => problem.source_line === 7 && problem.code === 'WARN_INVALID_PHONE'));
});
test('phone-only contacts are usable despite invalid email; no country or WhatsApp inference', () => {
  const parsed = parseReferenceCsv(csv('contacts', [[2, 'Cliente', '@', '11', '12345678'], [3, 'Outro', '', '+55 11', '999998888']]), 'contacts');
  assert.deepEqual(parsed.rows[0].phones, ['1112345678']); assert.deepEqual(parsed.rows[1].phones, []);
  assert(!parsed.problems.some(problem => problem.source_line === 2 && !problem.code.startsWith('WARN_')));
});
test('server accepts new positive branch codes and quarantines invalid or missing official fields', () => {
  const parsed = parseReferenceCsv(csv('descriptions', [[2, 'Cliente', '', '99', 'Válida', '999'], [3, '', '', '', '', '0']]), 'descriptions');
  assert.equal(parsed.rows[0].branch, '999'); assert.equal(parsed.stats.quarantined_rows, 1);
  assert.deepEqual(parsed.problems.map(problem => problem.code).sort(), ['INVALID_BRANCH', 'MISSING_CLIENT', 'MISSING_DESCRIPTION', 'MISSING_DOCUMENT']);
});
test('overlong source data remains in raw artifact but canonical values stay within SQL limits', () => {
  const source = csv('descriptions', [[2, 'C'.repeat(1501), 'K'.repeat(301), '1', 'D'.repeat(12001), '1']]);
  const parsed = parseReferenceCsv(source, 'descriptions'); assert.equal(parsed.rows[0].client_name, ''); assert.equal(parsed.rows[0].contract, null); assert.equal(parsed.rows[0].description, ''); assert.equal(parsed.stats.quarantined_rows, 1);
  assert.equal(parsed.problems.filter(problem => problem.code === 'FIELD_TOO_LONG').length, 3);
});
test('CSV boundaries, UTF8, physical lines, headers, quoting and method caps fail closed', () => {
  const valid = csv('contacts', [[2, 'Cliente', 'a@example.com', '', '']]);
  for (const bad of [valid.replace('source_line', 'line'), valid.replace('"2"', '"0"'), valid.replace('"2"', '"1000001"'), valid + referenceCsvRow([2, 'Duplicado', '', '', '']), valid.replace('"Cliente"', '"Cliente"extra'), valid.slice(0, -3), 'x'.repeat(REFERENCE_LIMITS.chunkBytes + 1)]) assert.throws(() => parseReferenceCsv(bad, 'contacts'));
  assert.throws(() => parseReferenceCsv(new Uint8Array([255]), 'contacts'));
  assert.throws(() => parseReferenceCsv(csv('contacts', Array.from({ length: 501 }, (_, index) => [index + 2, 'Cliente', '', '', ''])), 'contacts'), /500/);
  const many = parseReferenceCsv(csv('contacts', [[2, 'Cliente', Array.from({ length: 51 }, (_, index) => `a${index}@example.com`).join(';'), '', '']]), 'contacts');
  assert.equal(many.rows[0].emails.length, 50); assert(many.problems.some(problem => problem.code === 'LIMIT_METHODS'));
});
test('the real spaced phone headers and only their explicit historic aliases are accepted', () => {
  const original = csv('contacts', [[2, 'Cliente', '', '11', '999998888']]);
  assert.equal(parseReferenceCsv(original.replaceAll('T. 1:', 'T.1:'), 'contacts').rows.length, 1);
  assert.throws(() => parseReferenceCsv(original.replace('T. 1: ddd', 'DDD'), 'contacts'), /Cabeçalho/);
});
test('grouped contact report reads full DDD phones and only explicit WhatsApp channels', () => {
  const source = contactReportCsv([[12, ' Órgão  Sintético ', 'A@example.com\nb@example.org; a@example.com', '(31) 3222-2222\n(31) 98888-7777', '(31) 98888-7777 / (21) 97777-6666']]);
  const parsed = parseReferenceCsv(source, 'contacts');
  assert.deepEqual(parsed.rows[0], { source_line: 12, client_name: 'Órgão Sintético', client_document: null,
    emails: ['a@example.com', 'b@example.org'], phones: ['3132222222', '31988887777', '21977776666'],
    notes: 'WhatsApp cadastrado: (31) 98888-7777, (21) 97777-6666' });
  assert.deepEqual(parsed.problems, []);
  const ordinary = parseReferenceCsv(contactReportCsv([[2, 'Órgão', '', '(31) 98888-7777', '']]), 'contacts');
  assert.equal(ordinary.rows[0].notes, null); assert.deepEqual(ordinary.rows[0].phones, ['31988887777']);
  const onlyWhatsApp = parseReferenceCsv(contactReportCsv([[2, 'Órgão', '', '', '(31) 98888-7777']]), 'contacts');
  assert.equal(onlyWhatsApp.stats.quarantined_rows, 0); assert.deepEqual(onlyWhatsApp.rows[0].phones, ['31988887777']);
});
test('grouped report preserves explicit extensions and toll-free references without inventing DDD', () => {
  const source = contactReportCsv([[2, 'Órgão', 'a@example.com', '(31) 3222-2222 ramal 1035\n0800 032 1011\n0800 031 7140 ramal 203', '']]);
  const parsed = parseReferenceCsv(source, 'contacts');
  assert.deepEqual(parsed.rows[0].phones, ['3132222222', '08000321011', '08000317140']);
  assert.equal(parsed.rows[0].notes, 'Telefone informado: (31) 3222-2222 ramal 1035\nTelefone informado: 0800 031 7140 ramal 203');
  assert.deepEqual(parsed.problems.map(item => item.code), ['WARN_PHONE_NOTE']);
  assert.equal(parsed.stats.quarantined_rows, 0);
  const plainTollFree = parseReferenceCsv(contactReportCsv([[2, 'Órgão', '', '0800 032 1011', '']]), 'contacts');
  assert.deepEqual(plainTollFree.rows[0].phones, ['08000321011']); assert.equal(plainTollFree.rows[0].notes, null); assert.deepEqual(plainTollFree.problems, []);
});
test('grouped phone parsing rejects missing DDD, implicit country handling and malformed WhatsApp', () => {
  const parsed = parseReferenceCsv(contactReportCsv([[2, 'Órgão', 'a@example.com', '99999-8888\n+55 (31) 98888-7777\n0800abc1011', '(31) 98888-7777\n1234\n+55 (21) 97777-6666']]), 'contacts');
  assert.deepEqual(parsed.rows[0].phones, ['31988887777']);
  assert.equal(parsed.rows[0].notes, 'WhatsApp cadastrado: (31) 98888-7777');
  assert.deepEqual(parsed.problems.map(item => item.code), ['WARN_INVALID_PHONE', 'WARN_INVALID_WHATSAPP']);
  const missing = parseReferenceCsv(contactReportCsv([[2, 'Órgão', '', '99999-8888', 'errado']]), 'contacts');
  assert.equal(missing.stats.quarantined_rows, 1); assert(missing.problems.some(item => item.code === 'MISSING_CONTACT'));
});
test('new report headings are exact and cannot be mixed with legacy columns or descriptions', async () => {
  const source = contactReportCsv([[2, 'Órgão', 'a@example.com', '(31) 98888-7777', '']]);
  for (const modified of [source.replace('"E-mails"', '"Email"'), source.replace('"Telefones"', '"T. 1: ddd"'), source.replace('"WhatsApp cadastrado"', '"Celular"')]) assert.throws(() => parseReferenceCsv(modified, 'contacts'), /Cabeçalho/);
  assert.throws(() => parseReferenceCsv(source, 'descriptions'), /Cabeçalho/);
  await assert.rejects(convert(workbook('contacts', [row(2, ['Órgão', 'a@example.com', '(31) 98888-7777', ''])], { headers: ['Entidade: nome', 'E-mails', 'Telefones', 'Celular'] }), 'contacts'), /Cabeçalho/);
});
test('new report keeps source fields and physical lines in streamed artifacts while deduplicating exact rows', async () => {
  const values = ['Órgão Sintético', 'A@example.com\nb@example.org', '(31) 3222-2222 ramal 12', '(31) 98888-7777'];
  const source = workbook('contacts', [row(2, values), row(3, ['', '', '', '']), row(9, values), row(10, [...values.slice(0, 3), '(21) 97777-6666'])], { headers: REFERENCE_CONTACT_REPORT_HEADERS });
  const result = await convert(source, 'contacts'), artifact = new TextDecoder().decode(result.chunks[0].csv);
  assert.equal(result.stats.source_rows, 4); assert.equal(result.stats.blank_rows, 1); assert.equal(result.stats.duplicate_rows, 1); assert.equal(result.stats.emitted_rows, 2);
  assert(artifact.startsWith(referenceCsvRow(['source_line', ...REFERENCE_CONTACT_REPORT_HEADERS])));
  assert(artifact.includes(referenceCsvRow([2, ...values])));
  assert.deepEqual(parseReferenceCsv(artifact, 'contacts').rows.map(item => item.source_line), [2, 10]);
  assert.equal(await referenceSha256(result.chunks[0].csv), result.chunks[0].sha256);
  assert.equal(await referenceSha256(source), result.sourceSha256);
  assert.equal(result.stats.warning_count, 2); assert.equal(result.stats.quarantined_rows, 0);
  await assert.rejects(convert(workbook('contacts', [row(2, ['Órgão', 'a@example.com', '(31) 98888-7777', '', 'coluna extra'])], { headers: REFERENCE_CONTACT_REPORT_HEADERS }), 'contacts'), /fora das colunas/);
  await assert.rejects(convert(workbook('contacts', [row(2, ['Órgão', 'a@example.com', { inner: '<f>1+1</f><v>2</v>' }, ''])], { headers: REFERENCE_CONTACT_REPORT_HEADERS }), 'contacts'), /fórmula/);
});
test('new grouped contacts keep method and annotation caps without silently truncating valid imports', () => {
  const many = Array.from({ length: 51 }, (_, index) => `(31) 9${String(index).padStart(8, '0')}`).join('\n');
  const parsed = parseReferenceCsv(contactReportCsv([[2, 'Órgão', 'a@example.com', '', many]]), 'contacts');
  assert.equal(parsed.rows[0].phones.length, 50); assert.equal(parsed.stats.quarantined_rows, 1); assert(parsed.problems.some(item => item.code === 'LIMIT_METHODS'));
  const notes = Array.from({ length: 180 }, (_, index) => `(31) 3222-2222 ramal ${index}`).join('\n');
  const overlong = parseReferenceCsv(contactReportCsv([[2, 'Órgão', 'a@example.com', notes, '']]), 'contacts');
  assert.equal(overlong.rows[0].notes, null); assert.equal(overlong.stats.quarantined_rows, 1); assert(overlong.problems.some(item => item.code === 'FIELD_TOO_LONG' && item.field === 'notes'));
  const control = parseReferenceCsv(contactReportCsv([[2, 'Órgão', 'a@example.com', '(31)\u000B3222-2222 ramal 12', '']]), 'contacts');
  assert.equal(control.stats.quarantined_rows, 1); assert(control.problems.some(item => item.code === 'FIELD_TOO_LONG'));
});
test('new report streams every chunk with its explicit grouped header', async () => {
  const rows = Array.from({ length: 1001 }, (_, index) => row(index + 2, ['Órgão ' + index, 'a@example.com', '(31) 3222-2222', '(31) 98888-7777']));
  const result = await convert(workbook('contacts', rows, { headers: REFERENCE_CONTACT_REPORT_HEADERS }), 'contacts');
  assert.equal(result.chunks.length, 3); assert.equal(result.stats.emitted_rows, 1001); assert.equal(result.stats.problem_count, 0);
  for (const chunk of result.chunks) {
    assert(new TextDecoder().decode(chunk.csv).startsWith(referenceCsvRow(['source_line', ...REFERENCE_CONTACT_REPORT_HEADERS])));
    assert.equal(parseReferenceCsv(chunk.csv, 'contacts').rows.length, chunk.rowCount);
  }
});
test('streamed XLSX preserves physical lines, skips blanks and only deduplicates complete equal records', async () => {
  const result = await convert(workbook('descriptions', [row(2, ['Cliente', '', '001', 'Descrição A', '9']), row(3, ['', '', '', '', '']), row(9, ['Cliente', '', '001', 'Descrição A', '9']), row(10, ['Cliente', '', '001', 'Descrição B', '9']), row(14, ['', '', '002', 'Órfã', '9'])]), 'descriptions');
  assert.equal(result.stats.source_rows, 5); assert.equal(result.stats.blank_rows, 1); assert.equal(result.stats.duplicate_rows, 1); assert.equal(result.stats.emitted_rows, 3); assert.equal(result.stats.quarantined_rows, 1);
  assert.deepEqual(parseReferenceCsv(result.chunks[0].csv, 'descriptions').rows.map(item => item.source_line), [2, 10, 14]);
  assert.equal(result.sourceSha256.length, 64); assert.equal(await referenceSha256(result.chunks[0].csv), result.chunks[0].sha256);
});
test('shared strings rich text and integer zero formats preserve identifiers exactly', async () => {
  const styles = '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="000000"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>';
  const shared = '<sst><si><r><t>Cliente</t></r><r><t> Á</t></r><rPh><t>ignorar</t></rPh></si></sst>';
  const result = await convert(workbook('descriptions', [row(2, [{ attributes: 't="s"', inner: '<v>0</v>' }, '', { attributes: 's="1"', inner: '<v>123</v>' }, 'Descrição & texto', { inner: '<v>1.23E2</v>' }])], { parts: [['xl/styles.xml', styles], ['xl/sharedStrings.xml', shared]] }), 'descriptions');
  const title = parseReferenceCsv(result.chunks[0].csv, 'descriptions').rows[0]; assert.equal(title.client_name, 'Cliente Á'); assert.equal(title.document, '000123'); assert.equal(title.branch, '123'); assert.equal(title.description, 'Descrição & texto');
});
test('long integer identifiers never round through JavaScript Number', async () => {
  const result = await convert(workbook('descriptions', [row(2, ['Cliente', '', { inner: '<v>123456789012345678901234567890</v>' }, 'Descrição', '1'])]), 'descriptions');
  assert.equal(parseReferenceCsv(result.chunks[0].csv, 'descriptions').rows[0].document, '123456789012345678901234567890');
});
test('real formulas are rejected, while literal formula-looking descriptions remain inert', async () => {
  await assert.rejects(convert(workbook('descriptions', [row(2, ['Cliente', '', '1', { inner: '<f>HYPERLINK("x")</f><v>0</v>' }, '1'])]), 'descriptions'), /fórmula/);
  const result = await convert(workbook('descriptions', [row(2, ['Cliente', '', '1', '=literal', '1'])]), 'descriptions'); assert.equal(parseReferenceCsv(result.chunks[0].csv, 'descriptions').rows[0].description, '=literal');
});
test('DTD, custom XML entities, malformed shared indices and multiple sheets cannot produce a completed import', async () => {
  const data = workbook('contacts', [row(2, ['Cliente', 'a@example.com', '', ''])]);
  const badEntities = workbook('contacts', [], { sheet: '<!DOCTYPE x [<!ENTITY x "private">]><worksheet/>' });
  await assert.rejects(convert(badEntities, 'contacts'), /DTD/);
  await assert.rejects(convert(workbook('contacts', [], { sheet: '<worksheet><sheetData>' + row(1, REFERENCE_HEADERS.contacts) + '<row r="2"><c r="A2" t="inlineStr"><is><t>&custom;</t></is></c></row></sheetData></worksheet>' }), 'contacts'), /Entidade/);
  await assert.rejects(convert(workbook('contacts', [row(2, [{ attributes: 't="s"', inner: '<v>999</v>' }, 'a@example.com', '', ''])]), 'contacts'), /sharedStrings/);
  await assert.rejects(convert(workbook('contacts', [], { workbook: '<workbook><sheets><sheet r:id="rId1"/><sheet r:id="rId2"/></sheets></workbook>' }), 'contacts'), /única planilha/);
  assert(inspectReferenceZip(data).size > 0);
});
test('ZIP declared bombs, traversal, duplicate entries, encryption and overlapping records fail before decoding', () => {
  const basic = [['xl/workbook.xml', '<x/>']];
  assert.throws(() => inspectReferenceZip(zip([['../file', 'x']])), /Caminho/);
  assert.throws(() => inspectReferenceZip(zip([['a', 'x'], ['a', 'y']])), /repetido/);
  assert.throws(() => inspectReferenceZip(zip(basic, { modify(bytes, central) { new DataView(bytes.buffer).setUint32(central + 24, REFERENCE_LIMITS.expandedBytes + 1, true); new DataView(bytes.buffer).setUint32(22, REFERENCE_LIMITS.expandedBytes + 1, true); } })), /128 MiB/);
  assert.throws(() => inspectReferenceZip(zip(basic, { modify(bytes, central) { const v = new DataView(bytes.buffer); v.setUint16(6, 1, true); v.setUint16(central + 8, 1, true); } })), /criptografado/);
  assert.throws(() => inspectReferenceZip(zip([['a', 'x'], ['b', 'y']], { modify(bytes, central) { const v = new DataView(bytes.buffer), compressed = v.getUint32(central + 20, true); v.setUint32(18, compressed + 31, true); v.setUint32(central + 20, compressed + 31, true); } })), /sobrepostas/);
  assert.throws(() => inspectReferenceZip(new Uint8Array(REFERENCE_LIMITS.fileBytes + 1)), /16 MiB/);
});
test('actual decompressed CRC integrity is checked before successful completion', async () => {
  const bytes = workbook('contacts', [row(2, ['Cliente', 'a@example.com', '', ''])], { modify(bytes, central) { const view = new DataView(bytes.buffer); view.setUint32(14, 1, true); view.setUint32(central + 16, 1, true); } });
  await assert.rejects(convert(bytes, 'contacts'), /CRC/);
});
test('unexpected extra data is only omitted when official fields independently quarantine that physical row', async () => {
  const bad = await convert(workbook('descriptions', [row(2, ['Cliente', '', '1', 'Descrição', 'inválida', 'Dado extra'])]), 'descriptions');
  assert.equal(bad.stats.extra_column_rows, 1); assert.equal(bad.stats.extra_cells, 1); assert.equal(bad.stats.quarantined_rows, 1);
  await assert.rejects(convert(workbook('descriptions', [row(2, ['Cliente', '', '1', 'Descrição', '99', 'Dado extra'])]), 'descriptions'), /fora das colunas/);
});
test('CSV chunks are capped by bytes as well as rows and cannot run ahead of the acknowledged destination', async () => {
  const bytes = workbook('descriptions', Array.from({ length: 1200 }, (_, index) => row(index + 2, ['Cliente', '', String(index), 'D'.repeat(1800), '8'])));
  let resume, calls = 0; const gate = new Promise(resolve => { resume = resolve; });
  const promise = convert(bytes, 'descriptions', { onChunk: async () => { calls++; if (calls === 1) await gate; } });
  while (!calls) await new Promise(resolve => setTimeout(resolve, 5)); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1); resume();
  const result = await promise; assert(result.chunks.length > 3); assert.equal(result.stats.emitted_rows, 1200);
  for (const chunk of result.chunks) { assert(chunk.csv.length <= REFERENCE_LIMITS.chunkBytes); assert(chunk.rowCount <= REFERENCE_LIMITS.chunkRows); assert.equal(parseReferenceCsv(chunk.csv, 'descriptions').rows.length, chunk.rowCount); }
});
test('aborting or a failed stage callback stops further parsing and never emits a successful result', async () => {
  const bytes = workbook('contacts', Array.from({ length: 1100 }, (_, index) => row(index + 2, ['Cliente ' + index, 'a@example.com', '', ''])));
  const controller = new AbortController(); let count = 0;
  await assert.rejects(convert(bytes, 'contacts', { signal: controller.signal, onChunk: async () => { count++; controller.abort(); } }), error => error.name === 'AbortError'); assert.equal(count, 1);
  count = 0; await assert.rejects(convert(bytes, 'contacts', { onChunk: async () => { count++; throw new Error('stage_failed'); } }), /stage_failed/); assert.equal(count, 1);
});
test('a large synthetic source stays chunked, deduplicated and avoids retaining a worksheet object graph', async () => {
  const count = 18000, source = workbook('descriptions', Array.from({ length: count }, (_, index) => row(index + 2, ['Cliente ' + (index % 100), '', String(index % 9000), 'Descrição ' + index % 9000, '18'])));
  let maxRows = 0, maxBytes = 0, rawRows = 0;
  const result = await streamReferenceWorkbook(source, 'descriptions', { onChunk: async chunk => { maxRows = Math.max(maxRows, chunk.rowCount); maxBytes = Math.max(maxBytes, chunk.csv.length); rawRows += parseReferenceCsv(chunk.csv, 'descriptions').rows.length; } });
  assert.equal(result.stats.source_rows, count); assert.equal(result.stats.emitted_rows, 9000); assert.equal(result.stats.duplicate_rows, 9000); assert.equal(rawRows, 9000); assert(maxRows <= 500); assert(maxBytes <= 256 * 1024);
});
