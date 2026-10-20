// supabase/functions/receivables-import/index.ts
import ExcelJS from "npm:exceljs@4.4.0";

// src/lib/payables-parser.mjs
var MAX_FILE_BYTES = 2 * 1024 * 1024;
var MAX_ROWS = 5e3;
var ALIASES = {
  entry_number: ["LANCAMENTO", "NLANCAMENTO", "NOLANCAMENTO", "NUMEROLANCAMENTO", "NUMERODOLANCAMENTO", "NUMEROLANC", "NROLANCAMENTO"],
  description: ["HISTORICO", "DESCRICAO", "HISTORICOFAVORECIDO", "FAVORECIDO"],
  due_date: ["VENCIMENTO", "DATAVENCIMENTO", "DTVENCIMENTO", "VENCIMENTODATA"],
  amount_cents: ["VALOR", "VALORTITULO", "VALORORIGINAL", "EMISSAOVALORDOLANCAMENTO"],
  plan: ["PLANODECONTAS", "PLANOCONTAS", "PLANOCPCONTANOME"],
  branch: ["FILIAL", "CODFILIAL"],
  bank_account: ["BANCO", "CONTA", "BANCOCONTA", "PLANOCCCONTANOME"],
  issued_on: ["EMISSAO", "DATAEMISSAO", "DTEMISSAO", "EMISSAODATA"],
  source_status: ["STATUS", "SITUACAO"],
  cheque_number: ["CHEQUENUMERO"]
};
var headerMap = new Map(Object.entries(ALIASES).flatMap(([key, aliases]) => aliases.map((alias) => [alias, key])));
function parseCivilDate(value, excel1904 = false) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("Data inv\xE1lida.");
    if (value.getUTCHours() || value.getUTCMinutes() || value.getUTCSeconds() || value.getUTCMilliseconds()) throw new Error("A data cont\xE9m hor\xE1rio. Informe somente a data civil.");
    return civil(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > 2958465 || !excel1904 && value === 60) throw new Error("Data Excel inv\xE1lida ou cont\xE9m hor\xE1rio.");
    const epoch = excel1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const date = new Date(epoch + (value - (!excel1904 && value > 60 ? 1 : 0)) * 864e5);
    return civil(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const text2 = String(value ?? "").trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text2);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text2);
  if (!br && !iso) throw new Error("Use dd/mm/aaaa ou aaaa-mm-dd; datas abreviadas s\xE3o amb\xEDguas.");
  return br ? civil(+br[3], +br[2], +br[1]) : civil(+iso[1], +iso[2], +iso[3]);
}
function civil(year, month, day) {
  if (year < 1900 || year > 2199) throw new Error("Ano fora do intervalo de 1900 a 2199.");
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() + 1 !== month || candidate.getUTCDate() !== day) throw new Error("Data inexistente.");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function parseMoneyCents(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error("Informe um valor num\xE9rico positivo.");
    const decimal2 = String(value);
    if (!/^\d+(?:\.\d{1,2})?$/.test(decimal2)) throw new Error("O valor deve ter no m\xE1ximo duas casas decimais, sem arredondamento.");
    const [whole, fraction = ""] = decimal2.split(".");
    const cents2 = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (cents2 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Valor excede o limite seguro.");
    return Number(cents2);
  }
  let text2 = String(value ?? "").trim().replace(/^R\$\s*/, "");
  if (!text2) throw new Error("Valor obrigat\xF3rio.");
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text2)) throw new Error("Use valor brasileiro, por exemplo 1.234,56, com at\xE9 duas casas decimais.");
  text2 = text2.replaceAll(".", "");
  const [integer, decimal = ""] = text2.split(",");
  const cents = BigInt(integer) * 100n + BigInt(decimal.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Valor excede o limite seguro.");
  return Number(cents);
}
function parseCsv(text2, { maxRows = MAX_ROWS + 1 } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS + 21) throw new Error("Limite de linhas do CSV inv\xE1lido.");
  text2 = text2.replace(/^\uFEFF/, "");
  if (text2.includes("\0")) throw new Error("CSV cont\xE9m bytes inv\xE1lidos. Salve uma c\xF3pia em UTF-8.");
  const sample = text2.split(/\r?\n/, 1)[0];
  let quoted = false, commas = 0, semicolons = 0;
  for (let index = 0; index < sample.length; index++) {
    if (sample[index] === '"') {
      if (quoted && sample[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && sample[index] === ",") commas++;
    else if (!quoted && sample[index] === ";") semicolons++;
  }
  const delimiter = semicolons >= commas ? ";" : ",";
  const rows = [];
  let row = [], field = "", inQuote = false, closedQuote = false;
  function finishField() {
    row.push(field);
    field = "";
    closedQuote = false;
  }
  function finishRow() {
    finishField();
    rows.push(row);
    row = [];
    if (rows.length > maxRows) throw new Error(maxRows === MAX_ROWS + 1 ? "A base excede o limite de 5.000 linhas." : "O arquivo CSV excede o limite de linhas permitido.");
  }
  for (let index = 0; index < text2.length; index++) {
    const character = text2[index];
    if (inQuote) {
      if (character === '"') {
        if (text2[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuote = false;
          closedQuote = true;
        }
      } else field += character;
    } else if (character === '"') {
      if (field || closedQuote) throw new Error("Aspas inv\xE1lidas no CSV. Exporte novamente em UTF-8.");
      inQuote = true;
    } else if (character === delimiter) finishField();
    else if (character === "\r" || character === "\n") {
      if (character === "\r" && text2[index + 1] === "\n") index++;
      finishRow();
    } else {
      if (closedQuote) throw new Error("Texto ap\xF3s aspas de fechamento no CSV.");
      field += character;
    }
  }
  if (inQuote) throw new Error("CSV cont\xE9m aspas sem fechamento.");
  if (field || row.length || closedQuote) finishRow();
  return rows;
}
function inspectWorkbookZip(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (bytes.length < 22 || view.getUint32(0, true) !== 67324752) throw new Error("O arquivo n\xE3o \xE9 uma planilha XLSX/XLSM v\xE1lida.");
  let end = -1;
  for (let offset2 = bytes.length - 22; offset2 >= Math.max(0, bytes.length - 65557); offset2--) {
    if (view.getUint32(offset2, true) === 101010256 && offset2 + 22 + view.getUint16(offset2 + 20, true) === bytes.length) {
      end = offset2;
      break;
    }
  }
  if (end < 0) throw new Error("Estrutura da planilha inv\xE1lida.");
  const entries = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || entries > 256 || entries === 0 || start + size > end || start + size > bytes.length) throw new Error("Planilha multipartes, ZIP64 ou com quantidade excessiva de arquivos.");
  let offset = start, expanded = 0;
  const contents = [];
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 33639248) throw new Error("Diret\xF3rio da planilha inv\xE1lido.");
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), compressed = view.getUint32(offset + 20, true), uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (flags & 1 || ![0, 8].includes(method) || uncompressed === 4294967295 || compressed === 4294967295 || localOffset === 4294967295 || localOffset + 30 > start || view.getUint32(localOffset, true) !== 67324752) throw new Error("Planilhas criptografadas ou ZIP64 n\xE3o s\xE3o aceitas.");
    const contentStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (contentStart + compressed > start || view.getUint16(localOffset + 8, true) !== method || view.getUint16(localOffset + 6, true) & 1) throw new Error("Conte\xFAdo ZIP inconsistente.");
    contents.push({ start: contentStart, compressed, uncompressed, method });
    expanded += uncompressed;
    if (expanded > 20 * 1024 * 1024) throw new Error("Conte\xFAdo expandido excede 20 MiB. Divida a base por uma origem completa autorizada.");
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > start + size) throw new Error("Planilha truncada.");
  }
  if (offset !== start + size) throw new Error("Diret\xF3rio ZIP inconsistente.");
  return contents;
}
async function validateWorkbookExpandedSize(buffer) {
  const contents = inspectWorkbookZip(buffer);
  let total = 0;
  for (const content of contents) {
    let actual = 0;
    if (content.method === 0) {
      actual = content.compressed;
      total += actual;
    } else {
      const reader = new Blob([buffer.slice(content.start, content.start + content.compressed)]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
      try {
        for (; ; ) {
          const chunk = await reader.read();
          if (chunk.done) break;
          actual += chunk.value.byteLength;
          total += chunk.value.byteLength;
          if (actual > content.uncompressed || total > 20 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("Conte\xFAdo expandido excede o tamanho seguro declarado ou 20 MiB.");
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    if (total > 20 * 1024 * 1024 || actual !== content.uncompressed) throw new Error("Tamanho expandido da planilha \xE9 inconsistente ou excede 20 MiB.");
  }
}

// src/lib/receivables-parser.mjs
var COLUMN_LABELS = { document: "Documento / NF", client_name: "Cliente / \xD3rg\xE3o", branch: "Filial", due_date: "Vencimento", amount_cents: "Valor", issued_on: "Emiss\xE3o", client_document: "CNPJ", received_on: "Quita\xE7\xE3o: data do recebimento", received_amount_cents: "Quita\xE7\xE3o: valor recebido" };
var REQUIRED = ["document", "client_name", "branch", "due_date", "amount_cents"];
var normalize = (value) => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
var ALIASES2 = {
  document: ["DOCUMENTO", "NF", "NOTAFISCAL", "NUMERODOCUMENTO", "NUMERONF", "DOCUMENTONUMERO"],
  client_name: ["CLIENTE", "ORGAO", "CLIENTEORGAO", "ORGAOCLIENTE", "ENTIDADE1ENTIDADENOME"],
  branch: ["FILIAL", "CODFILIAL"],
  due_date: ["VENCIMENTO", "DATAVENCIMENTO", "DTVENCIMENTO", "VENCIMENTODATA"],
  amount_cents: ["VALOR", "VALORTITULO", "VALORORIGINAL", "EMISSAOVALORDOLANCAMENTO"],
  issued_on: ["EMISSAO", "DATAEMISSAO", "DTEMISSAO", "EMISSAODATA"],
  client_document: ["CNPJ", "CNPJCLIENTE", "DOCUMENTOCLIENTE"],
  received_on: ["QUITACAODATADORECEBIMENTO"],
  received_amount_cents: ["QUITACAOVALORRECEBIDO"]
};
var headerMap2 = new Map(Object.entries(ALIASES2).flatMap(([key, aliases]) => aliases.map((alias) => [alias, key])));
var ERP_TIMESTAMP_HEADERS = /* @__PURE__ */ new Set(["EMISSAODATA", "VENCIMENTODATA", "QUITACAODATADORECEBIMENTO"]);
function scalar(value) {
  if (value === null || value === void 0) return "";
  if (typeof value === "object" && !(value instanceof Date)) {
    if ("formula" in value || "sharedFormula" in value) throw new Error("F\xF3rmula n\xE3o permitida. Salve uma c\xF3pia apenas com valores.");
    if ("richText" in value) return scalar(value.richText.map((part) => part.text).join(""));
    if ("text" in value && "hyperlink" in value) return scalar(value.text);
    throw new Error("C\xE9lula com conte\xFAdo n\xE3o suportado. Use somente valores.");
  }
  if (typeof value === "string" && /^\s*[=+@]/.test(value)) throw new Error("Conte\xFAdo interpret\xE1vel como f\xF3rmula. Salve somente valores.");
  if (!["string", "number"].includes(typeof value) && !(value instanceof Date)) throw new Error("Tipo de c\xE9lula inv\xE1lido. Use somente texto, data ou n\xFAmero.");
  return value;
}
function parseErpDate(value, excel1904) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("Data inv\xE1lida.");
    return parseCivilDate(`${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 1 || value > 2958465) throw new Error("Data Excel inv\xE1lida.");
    return parseCivilDate(Math.floor(value), excel1904);
  }
  const timestamp = /^(\d{2}\/\d{2}\/\d{4}) +(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? "").trim());
  if (!timestamp) return parseCivilDate(value, excel1904);
  if (+timestamp[2] > 23 || +timestamp[3] > 59 || +(timestamp[4] ?? 0) > 59) throw new Error("Hor\xE1rio inv\xE1lido. Use hh:mm ou hh:mm:ss, entre 00:00:00 e 23:59:59.");
  return parseCivilDate(timestamp[1], excel1904);
}
var INVALID_IDENTIFIER = "Identificador de documento inv\xE1lido. Use texto ou n\xFAmero inteiro n\xE3o negativo, sem nota\xE7\xE3o cient\xEDfica.";
var UNSUPPORTED_IDENTIFIER_FORMAT = "Formato do identificador n\xE3o suportado. No Excel, use Texto ou um formato simples de zeros, como 000000.";
function parseIdentifier(value) {
  const primitive = scalar(value);
  if (typeof primitive === "number") {
    if (!Number.isSafeInteger(primitive) || primitive < 0) throw new Error(INVALID_IDENTIFIER);
    return String(primitive);
  }
  if (typeof primitive !== "string") throw new Error(INVALID_IDENTIFIER);
  const text2 = primitive.trim().replace(/\s+/g, " ");
  if (text2.length > 150) throw new Error("Limite de 150 caracteres excedido.");
  if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)[eE][+-]?\d+$/.test(text2) || /^-\d+(?:[.,]\d+)?$/.test(text2) || /[\u0000-\u001f\u007f]/.test(text2)) throw new Error(INVALID_IDENTIFIER);
  return text2;
}
function isReceivableIdentifierHeader(value) {
  return headerMap2.get(normalize(scalar(value))) === "document";
}
function readReceivableIdentifierCell(value, numFmt) {
  if (value instanceof Date) throw new Error(UNSUPPORTED_IDENTIFIER_FORMAT);
  const text2 = parseIdentifier(value);
  if (typeof value !== "number") return text2;
  const format = String(numFmt ?? "").trim();
  if (!format || format.toUpperCase() === "GENERAL" || format === "@") return text2;
  if (!/^0+$/.test(format)) throw new Error(UNSUPPORTED_IDENTIFIER_FORMAT);
  if (format.length > 150) throw new Error("Limite de 150 caracteres excedido.");
  return text2.padStart(format.length, "0");
}
function readReceivableIdentifierCellResult(value, numFmt, line, column) {
  try {
    return { value: readReceivableIdentifierCell(value, numFmt), error: null };
  } catch (error) {
    let letters = "", index = column;
    while (index > 0) {
      index--;
      letters = String.fromCharCode(65 + index % 26) + letters;
      index = Math.floor(index / 26);
    }
    const address = `${letters}${line}`;
    return { value, error: {
      line,
      column: `${COLUMN_LABELS.document} (${address})`,
      problem: error instanceof Error ? error.message : INVALID_IDENTIFIER,
      correction: `Confira a c\xE9lula ${address} e o alinhamento da linha no arquivo original. Mantenha a nota, o valor e as datas nas respectivas colunas.`
    } };
  }
}
function mergeReceivableImportProblems(parserErrors, cellErrors = []) {
  const seen = /* @__PURE__ */ new Set(), errors = [];
  for (const error of [...cellErrors, ...parserErrors]) {
    const column = error.column.replace(/ \([A-Z]+\d+\)$/, ""), key = JSON.stringify([error.line, column]);
    if (!seen.has(key)) {
      seen.add(key);
      errors.push(error);
    }
  }
  return errors.sort((first, second) => first.line - second.line || first.column.localeCompare(second.column, "pt-BR")).slice(0, 100);
}
function receivableCustomerKey(row) {
  return row.client_document ? `cnpj:${row.client_document}` : `name:${row.client_name.trim().replace(/\s+/g, " ").toUpperCase()}`;
}
function validateReceivableMatrix(matrix, { excel1904 = false } = {}, received = false) {
  const errors = [], rows = [];
  if (!matrix.length) return { rows, errors: [{ line: 1, column: "Arquivo", problem: "Arquivo vazio.", correction: "Exporte o relat\xF3rio completo com os cabe\xE7alhos." }] };
  if (matrix[0].length > 100) return { rows, errors: [{ line: 1, column: "Arquivo", problem: "Mais de 100 colunas.", correction: "Salve uma c\xF3pia com at\xE9 100 colunas." }] };
  const columns = /* @__PURE__ */ new Map(), timestampColumns = /* @__PURE__ */ new Set();
  matrix[0].forEach((value, index) => {
    let key;
    try {
      const normalizedHeader = normalize(scalar(value));
      key = headerMap2.get(normalizedHeader);
      if (ERP_TIMESTAMP_HEADERS.has(normalizedHeader)) timestampColumns.add(index);
    } catch {
      errors.push({ line: 1, column: "Cabe\xE7alho", problem: "Cabe\xE7alho inv\xE1lido.", correction: "Use nomes de colunas sem f\xF3rmulas." });
      return;
    }
    if (key && columns.has(key)) errors.push({ line: 1, column: COLUMN_LABELS[key], problem: "Coluna duplicada ou amb\xEDgua.", correction: "Mantenha uma \xFAnica coluna para este campo." });
    else if (key) columns.set(key, index);
  });
  for (const key of [...REQUIRED, ...received ? ["received_on", "received_amount_cents"] : []]) if (!columns.has(key)) errors.push({ line: 1, column: COLUMN_LABELS[key], problem: "Coluna obrigat\xF3ria ausente.", correction: `Inclua a coluna ${COLUMN_LABELS[key]}.` });
  if (errors.length) return { rows, errors };
  const keys = /* @__PURE__ */ new Set(), recognized = new Set(columns.values());
  let total = 0, receivedTotal = 0, nonempty = 0;
  for (let index = 1; index < matrix.length; index++) {
    const source = matrix[index];
    if (source.every((value) => value === null || value === void 0 || String(value).trim() === "")) continue;
    if (++nonempty > MAX_ROWS) {
      errors.push({ line: index + 1, column: "Arquivo", problem: "Mais de 5.000 linhas.", correction: "Exporte uma origem completa dentro do limite." });
      break;
    }
    const row = { document: "", client_name: "", client_document: null, branch: "", issued_on: null, due_date: "", amount_cents: 0 };
    if (received) {
      row.received_on = "";
      row.received_amount_cents = 0;
    }
    const before = errors.length;
    if (source.length > 100 || source.length > matrix[0].length && source.slice(matrix[0].length).some((value) => value !== null && value !== void 0 && String(value).trim())) errors.push({ line: index + 1, column: "Arquivo", problem: "H\xE1 valores fora das colunas do cabe\xE7alho ou mais de 100 colunas.", correction: "Confira delimitadores e cabe\xE7alhos; valores com v\xEDrgula em CSV devem estar entre aspas." });
    source.forEach((value, column) => {
      if (!recognized.has(column)) try {
        scalar(value);
      } catch (error) {
        errors.push({ line: index + 1, column: `Coluna ${column + 1}`, problem: error.message, correction: "Salve uma c\xF3pia somente com valores, sem f\xF3rmulas." });
      }
    });
    for (const [key, column] of columns) {
      try {
        const value = scalar(source[column]);
        if (!received && ["received_on", "received_amount_cents"].includes(key)) continue;
        if (key === "amount_cents" || key === "received_amount_cents") {
          row[key] = parseMoneyCents(value);
          if (key === "received_amount_cents" && row[key] <= 0) throw new Error("O valor recebido deve ser maior que zero.");
        } else if (key === "due_date" || key === "received_on") row[key] = timestampColumns.has(column) ? parseErpDate(value, excel1904) : parseCivilDate(value, excel1904);
        else if (key === "issued_on") row[key] = String(value).trim() ? timestampColumns.has(column) ? parseErpDate(value, excel1904) : parseCivilDate(value, excel1904) : null;
        else if (key === "document") {
          row[key] = parseIdentifier(value);
          if (!row[key]) throw new Error("Campo obrigat\xF3rio vazio.");
        } else if (key === "client_document") {
          const document = String(value).trim();
          if (!document) row[key] = null;
          else {
            if (!/^[\d.\s/-]+$/.test(document)) throw new Error("CNPJ inv\xE1lido. Informe 14 d\xEDgitos, com ou sem pontua\xE7\xE3o.");
            const digits = document.replace(/\D/g, "");
            if (digits.length !== 14) throw new Error("CNPJ deve conter exatamente 14 d\xEDgitos. N\xE3o complete zeros automaticamente.");
            row[key] = digits;
          }
        } else {
          row[key] = String(value).trim().replace(/\s+/g, " ");
          if (!row[key]) throw new Error("Campo obrigat\xF3rio vazio.");
          const maximum = key === "client_name" ? 1500 : 150;
          if (row[key].length > maximum) throw new Error(`Limite de ${maximum} caracteres excedido.`);
        }
      } catch (error) {
        errors.push({ line: index + 1, column: COLUMN_LABELS[key], problem: error.message, correction: "Corrija a c\xE9lula no arquivo original e selecione uma nova c\xF3pia." });
      }
    }
    const identity = JSON.stringify([row.branch, row.document, receivableCustomerKey(row), row.due_date]);
    if (errors.length === before && keys.has(identity)) errors.push({ line: index + 1, column: "Documento / NF", problem: "Chave de t\xEDtulo duplicada na mesma base.", correction: "Confira filial, documento, cliente e vencimento. Uma altera\xE7\xE3o de valor n\xE3o cria outro t\xEDtulo." });
    if (errors.length === before) {
      total += row.amount_cents;
      if (received) receivedTotal += row.received_amount_cents;
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(receivedTotal)) errors.push({ line: index + 1, column: "Valor", problem: "Total do relat\xF3rio excede o limite de precis\xE3o.", correction: "Confira valores e origem da base antes de importar." });
      else {
        keys.add(identity);
        rows.push(row);
      }
    }
    if (errors.length >= 100) break;
  }
  if (!rows.length && !errors.length) errors.push({ line: 2, column: "Arquivo", problem: "N\xE3o h\xE1 t\xEDtulos no relat\xF3rio.", correction: "Selecione um relat\xF3rio completo com t\xEDtulos; uma base vazia n\xE3o pode gerar aus\xEAncias." });
  return { rows: errors.length ? [] : rows, errors: errors.slice(0, 100) };
}
function validateReceivableRows(matrix, options = {}) {
  return validateReceivableMatrix(matrix, options, false);
}
function validateReceivablePaidRows(matrix, options = {}) {
  return validateReceivableMatrix(matrix, options, true);
}

// supabase/functions/receivables-import/open-report-contract.mjs
var UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
var uuid = (value) => typeof value === "string" && UUID.test(value);
var count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 5e3;
var text = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
function validOpenReportReference(value) {
  try {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && parseCivilDate(value) === value;
  } catch {
    return false;
  }
}
function validCounters(value, fullReport) {
  return ["retired_count", "retired_worked_count", "retired_unworked_count", "reappeared_count"].every((key) => count(value[key])) && value.retired_count === value.retired_worked_count + value.retired_unworked_count && (fullReport || value.retired_count === 0);
}
function validOpenReportPreview(preview, { fullReport, referenceDate, rowCount }) {
  if (preview?.format_version !== "receivables-open-report-v1" || preview.full_report !== fullReport || preview.reference_date !== referenceDate || !validOpenReportReference(preview.reference_date) || !validCounters(preview, fullReport) || preview.reappeared_count > rowCount || !(preview.previous_import_id === null || uuid(preview.previous_import_id)) || !Array.isArray(preview.retirement_items) || preview.retirement_items.length !== preview.retired_count) return false;
  const present = new Set(preview.rows.map((row) => row.title_id).filter(Boolean)), seen = /* @__PURE__ */ new Set();
  let worked = 0;
  for (const item of preview.retirement_items) {
    if (!uuid(item?.title_id) || seen.has(item.title_id) || present.has(item.title_id) || !text(item.client_name, 1500) || !text(item.document, 150) || !text(item.branch, 150) || !validOpenReportReference(item.due_date) || !Number.isSafeInteger(item.amount_cents) || item.amount_cents < 0 || !(item.collector_id === null || uuid(item.collector_id)) || typeof item.worked !== "boolean") return false;
    seen.add(item.title_id);
    if (item.worked) worked++;
  }
  return worked === preview.retired_worked_count;
}
function validOpenReportCommit(result, { fullReport, referenceDate, requestId, rowCount }) {
  return result?.format_version === "receivables-open-report-v1" && result.full_report === fullReport && result.reference_date === referenceDate && validOpenReportReference(result.reference_date) && result.row_count === rowCount && uuid(result.import_id) && uuid(result.request_id) && result.request_id.toLowerCase() === requestId.toLowerCase() && typeof result.idempotent === "boolean" && validCounters(result, fullReport) && result.reappeared_count <= rowCount;
}

// supabase/functions/receivables-import/handler.mjs
var MAX_BODY_BYTES = 3 * 1024 * 1024;
var MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_FILE_BYTES / 3);
var UUID2 = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
var SERVICE_FAILURE = "N\xE3o foi poss\xEDvel confirmar a opera\xE7\xE3o. Atualize o hist\xF3rico antes de tentar novamente.";
var RECEIVABLES_GATEWAY_SCHEMA = "receivables-import/2026-10-19.1";
var DIAGNOSTIC_CODES = /* @__PURE__ */ new Set([
  "42501",
  "40001",
  "23505",
  "23514",
  "22023",
  "57014",
  "55P03",
  "42P01",
  "42883",
  "P0023",
  "P0024",
  "P0030",
  "P0047",
  "PGRST202",
  "PGRST301",
  "PGRST303",
  "CR_SERVICE_UNAVAILABLE",
  "CR_REQUEST_TIMEOUT",
  "CR_UPSTREAM_TIMEOUT",
  "CR_INVALID_PREVIEW",
  "CR_INVALID_RESPONSE",
  "CR_REQUEST_INVALID",
  "CR_RATE_LIMITED"
]);
var INVALID_REQUEST = "Solicita\xE7\xE3o inv\xE1lida. Selecione novamente o relat\xF3rio completo.";
var PARSE_FAILURE = "N\xE3o foi poss\xEDvel analisar o arquivo. Salve uma c\xF3pia somente com valores e confira os cabe\xE7alhos.";
var CORRECTION = "Confira o formato e os cabe\xE7alhos, salve uma c\xF3pia somente com valores e tente novamente.";
var IDENTITY_CHANGE = "Poss\xEDvel altera\xE7\xE3o de identifica\xE7\xE3o do cliente. CNPJ inclu\xEDdo, removido ou alterado pode duplicar a d\xEDvida. Solicite corre\xE7\xE3o administrativa antes de importar.";
var SAFE_MESSAGES = /* @__PURE__ */ new Set([
  "Arquivo vazio.",
  "Cabe\xE7alho inv\xE1lido.",
  "Coluna duplicada ou amb\xEDgua.",
  "Coluna obrigat\xF3ria ausente.",
  "Mais de 5.000 linhas.",
  "H\xE1 valores fora das colunas do cabe\xE7alho.",
  "Chave de t\xEDtulo duplicada na mesma base.",
  "Total do relat\xF3rio excede o limite de precis\xE3o.",
  "N\xE3o h\xE1 t\xEDtulos no relat\xF3rio.",
  "F\xF3rmula n\xE3o permitida. Salve uma c\xF3pia apenas com valores.",
  "Conte\xFAdo interpret\xE1vel como f\xF3rmula. Salve somente valores.",
  "C\xE9lula com conte\xFAdo n\xE3o suportado. Use somente valores.",
  "Campo obrigat\xF3rio vazio.",
  "Data inv\xE1lida.",
  "A data cont\xE9m hor\xE1rio. Informe somente a data civil.",
  "Data Excel inv\xE1lida ou cont\xE9m hor\xE1rio.",
  "Use dd/mm/aaaa ou aaaa-mm-dd; datas abreviadas s\xE3o amb\xEDguas.",
  "Ano fora do intervalo de 1900 a 2199.",
  "Data inexistente.",
  "Informe um valor num\xE9rico positivo.",
  "O valor deve ter no m\xE1ximo duas casas decimais.",
  "Valor obrigat\xF3rio.",
  "Use valor brasileiro, por exemplo 1.234,56, com at\xE9 duas casas decimais.",
  "Valor excede o limite seguro.",
  "CSV cont\xE9m bytes inv\xE1lidos. Salve uma c\xF3pia em UTF-8.",
  "A base excede o limite de 5.000 linhas.",
  "Aspas inv\xE1lidas no CSV. Exporte novamente em UTF-8.",
  "Texto ap\xF3s aspas de fechamento no CSV.",
  "CSV cont\xE9m aspas sem fechamento.",
  "O arquivo n\xE3o \xE9 uma planilha XLSX/XLSM v\xE1lida.",
  "Estrutura da planilha inv\xE1lida.",
  "Planilha multipartes, ZIP64 ou com quantidade excessiva de arquivos.",
  "Diret\xF3rio da planilha inv\xE1lido.",
  "Planilhas criptografadas ou ZIP64 n\xE3o s\xE3o aceitas.",
  "Conte\xFAdo ZIP inconsistente.",
  "Conte\xFAdo expandido excede 20 MiB. Divida a base por uma origem completa autorizada.",
  "Planilha truncada.",
  "Diret\xF3rio ZIP inconsistente.",
  "Conte\xFAdo expandido excede o tamanho seguro declarado ou 20 MiB.",
  "Tamanho expandido da planilha \xE9 inconsistente ou excede 20 MiB.",
  "A c\xF3pia para importa\xE7\xE3o deve conter uma \xFAnica aba com dados.",
  "Planilha excede 5.000 linhas ou 100 colunas.",
  "CNPJ inv\xE1lido. Informe 14 d\xEDgitos, com ou sem pontua\xE7\xE3o.",
  "CNPJ deve conter exatamente 14 d\xEDgitos. N\xE3o complete zeros automaticamente.",
  "Mais de 100 colunas.",
  "H\xE1 valores fora das colunas do cabe\xE7alho ou mais de 100 colunas.",
  "Tipo de c\xE9lula inv\xE1lido. Use somente texto, data ou n\xFAmero.",
  "O valor deve ter no m\xE1ximo duas casas decimais, sem arredondamento.",
  "Data Excel inv\xE1lida.",
  "Hor\xE1rio inv\xE1lido. Use hh:mm ou hh:mm:ss, entre 00:00:00 e 23:59:59.",
  "Identificador de documento inv\xE1lido. Use texto ou n\xFAmero inteiro n\xE3o negativo, sem nota\xE7\xE3o cient\xEDfica.",
  "Formato do identificador n\xE3o suportado. No Excel, use Texto ou um formato simples de zeros, como 000000.",
  "O valor recebido deve ser maior que zero.",
  "Este arquivo cont\xE9m colunas de quita\xE7\xE3o. Selecione o modo Recebimentos para importar datas e valores efetivamente recebidos."
]);
var safeMessage = (message) => SAFE_MESSAGES.has(message) || /^Limite de (?:150|300|1500) caracteres excedido\.$/.test(message) ? message : PARSE_FAILURE;
function originsFrom(raw) {
  const values = String(raw || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw new Error("missing_origins");
  return new Set(values.map((value) => {
    const url = new URL(value);
    if (url.origin !== value || !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("invalid_origin");
    return value;
  }));
}
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new Error("invalid_body");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Error("invalid_body");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_body");
  const chunks = [];
  let length = 0;
  try {
    for (; ; ) {
      const { done, value: value2 } = await reader.read();
      if (done) break;
      length += value2.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("invalid_body");
      }
      chunks.push(value2);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
  return value;
}
function decodeFile(encoded) {
  if (typeof encoded !== "string" || !encoded.length || encoded.length > MAX_BASE64_LENGTH || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error("invalid_base64");
  const binary = atob(encoded);
  if (!binary.length || binary.length > MAX_FILE_BYTES || btoa(binary) !== encoded) throw new Error("invalid_base64");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function verifiedSessionId(token, userId) {
  const part = token.split(".")[1];
  if (!part) throw new Error("invalid_session");
  const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  if (payload.sub !== userId || typeof payload.session_id !== "string" || !UUID2.test(payload.session_id)) throw new Error("invalid_session");
  return payload.session_id;
}
function problemsFor(errors) {
  return errors.slice(0, 100).map((error) => ({
    line: Number.isSafeInteger(error.line) && error.line >= 0 && error.line <= MAX_ROWS + 2 ? error.line : 0,
    column: typeof error.column === "string" ? error.column.slice(0, 80) : "Arquivo",
    problem: safeMessage(typeof error.problem === "string" ? error.problem : ""),
    correction: typeof error.correction === "string" ? error.correction.slice(0, 300) : CORRECTION
  }));
}
function receiptColumn(value) {
  if (value && typeof value === "object") {
    if ("formula" in value || "sharedFormula" in value) return false;
    if (Array.isArray(value.richText)) value = value.richText.map((part) => part?.text ?? "").join("");
    else if (typeof value.text === "string" && "hyperlink" in value) value = value.text;
  }
  const normalized = String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return ["QUITACAODATADORECEBIMENTO", "QUITACAOVALORRECEBIDO"].includes(normalized);
}
var validRevision = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim();
var sourceFields = ["document", "due_date", "amount_cents"];
var validCustomerKey = (value) => typeof value === "string" && value.length <= 1505 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && (/^cnpj:\d{14}$/.test(value) || value.startsWith("name:") && value.length > 5 && value.slice(5) === value.slice(5).trim());
function validCollectorMappings(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= MAX_ROWS && Object.entries(value).every(([key, collector]) => validCustomerKey(key) && typeof collector === "string" && UUID2.test(collector)) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 1024 * 1024;
}
function validCollectorPreview(preview, rows) {
  if (preview.collector_assignment_version !== "030" || !Array.isArray(preview.customer_collector_assignments) || preview.customer_collector_assignments.length > rows.length || !Number.isSafeInteger(preview.missing_collector_count) || preview.missing_collector_count < 0 || preview.missing_collector_count > preview.customer_collector_assignments.length) return false;
  if (preview.rows.some((row, index) => row.customer_key !== receivableCustomerKey(rows[index]) || ["client_name", "client_document", "branch", "issued_on"].some((key) => row[key] !== rows[index][key]))) return false;
  const groups = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const key = receivableCustomerKey(row), group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  if (preview.customer_collector_assignments.length !== groups.size) return false;
  const seen = /* @__PURE__ */ new Set();
  let missing = 0;
  for (const assignment of preview.customer_collector_assignments) {
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment) || !validCustomerKey(assignment.customer_key) || seen.has(assignment.customer_key)) return false;
    const group = groups.get(assignment.customer_key);
    if (!group) return false;
    if (typeof assignment.client_name !== "string" || !group.some((row) => row.client_name === assignment.client_name) || assignment.client_document !== group[0].client_document || assignment.row_count !== group.length || !(assignment.collector_id === null || typeof assignment.collector_id === "string" && UUID2.test(assignment.collector_id)) || !(assignment.collector_name === null || typeof assignment.collector_name === "string" && !!assignment.collector_name.trim() && assignment.collector_name.length <= 1500 && !/[\u0000-\u001f\u007f-\u009f]/.test(assignment.collector_name)) || assignment.collector_id === null !== (assignment.collector_name === null) || typeof assignment.requires_selection !== "boolean" || typeof assignment.locked !== "boolean") return false;
    seen.add(assignment.customer_key);
    if (assignment.requires_selection && assignment.collector_id === null) missing++;
  }
  return missing === preview.missing_collector_count && (!missing || preview.can_commit === false);
}
function createReceivablesGateway({ env, fetch: fetcher = globalThis.fetch, loadWorkbook, log = () => {
}, requestTimeoutMs = 5e4 }) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 6e4) throw new Error("invalid_request_budget");
  return async function handle(request) {
    const started = performance.now(), requestId = crypto.randomUUID();
    let stage = "configuration";
    function diagnostic(status, payload) {
      const fallback = status === 401 ? "PGRST301" : status === 403 ? "42501" : status === 429 ? "CR_RATE_LIMITED" : status >= 500 ? "CR_SERVICE_UNAVAILABLE" : "CR_REQUEST_INVALID";
      const code = DIAGNOSTIC_CODES.has(payload.code) ? payload.code : fallback;
      if (status >= 500) {
        try {
          log({
            event: "receivables_import_failure",
            stage,
            code,
            elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
            request_id: requestId
          });
        } catch {
        }
      }
      return { ...payload, code, request_id: requestId, stage, schema_version: RECEIVABLES_GATEWAY_SCHEMA };
    }
    let origins;
    try {
      origins = originsFrom(env("ALLOWED_ORIGINS"));
    } catch {
      return new Response(JSON.stringify(diagnostic(503, { error: SERVICE_FAILURE })), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    stage = "cors";
    const origin = request.headers.get("origin");
    if (!origin || !origins.has(origin)) return new Response(JSON.stringify(diagnostic(403, { error: "Origem n\xE3o autorizada." })), { status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" } });
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin"
    };
    const respond = (status, payload, extra = {}) => new Response(JSON.stringify(status >= 400 ? diagnostic(status, payload) : payload), { status, headers: { ...headers, ...extra } });
    if (request.method === "OPTIONS") {
      const requested = (request.headers.get("access-control-request-headers") || "").toLowerCase().split(",").map((name) => name.trim()).filter(Boolean);
      if (request.headers.get("access-control-request-method") !== "POST" || requested.some((name) => !["authorization", "content-type", "apikey", "x-client-info"].includes(name))) return respond(403, { error: "Solicita\xE7\xE3o n\xE3o permitida." });
      return new Response(null, { status: 204, headers: {
        ...headers,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
        "Access-Control-Max-Age": "600"
      } });
    }
    stage = "request";
    if (request.method !== "POST") return respond(405, { error: "M\xE9todo n\xE3o permitido." }, { Allow: "POST, OPTIONS" });
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/i)?.[1];
    if (!token) return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
    stage = "configuration";
    let base, serviceKey, anonKey;
    try {
      serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
      anonKey = env("SUPABASE_ANON_KEY");
      const url = new URL(env("SUPABASE_URL"));
      if (!serviceKey || !anonKey || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid_environment");
      base = url.origin;
    } catch {
      return respond(503, { error: SERVICE_FAILURE });
    }
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);
    async function call(path, { service = false, method = "POST", data } = {}) {
      const result = await fetcher(`${base}${path}`, {
        method,
        headers: { apikey: service ? serviceKey : anonKey, Authorization: `Bearer ${service ? serviceKey : token}`, "Content-Type": "application/json" },
        body: data === void 0 ? void 0 : JSON.stringify(data),
        signal
      });
      let payload = null;
      try {
        payload = await result.json();
      } catch {
      }
      return { ok: result.ok, status: result.status, payload };
    }
    function upstreamFailure(result) {
      const code = result.payload?.code;
      if (code === "57014") return respond(504, { code, error: "O banco interrompeu a consulta. Preserve o arquivo e confira o hist\xF3rico antes de tentar novamente." });
      if (code === "55P03") return respond(503, { code, error: "A base est\xE1 ocupada com outra opera\xE7\xE3o. Preserve o arquivo e confira o hist\xF3rico antes de tentar novamente." });
      if (["PGRST202", "42883", "42P01"].includes(code)) return respond(409, { code, activation_required: true, error: "Atualize a fun\xE7\xE3o de importa\xE7\xE3o e a estrutura de Contas a Receber antes de tentar novamente." });
      if (code === "PGRST301" || code === "PGRST303") return respond(401, { code, error: "Sua sess\xE3o expirou. Entre novamente." });
      if (code === "42501") return respond(403, { code, error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      if (code === "40001") return respond(409, { code, error: "A base mudou desde a an\xE1lise. Analise o arquivo novamente antes de concluir." });
      if (code === "23505") return respond(409, { code, error: "Este arquivo j\xE1 foi importado para esta origem. Nenhum dado foi alterado." });
      if (code === "P0023") return respond(409, { code, error: "Confira os v\xEDnculos e as poss\xEDveis altera\xE7\xF5es de identifica\xE7\xE3o dos t\xEDtulos antes de confirmar. Nenhum dado foi alterado." });
      if (code === "P0024") return respond(409, { code, error: "H\xE1 recebimentos que precisam de revis\xE3o. Confira os v\xEDnculos, valores e hist\xF3rico antes de confirmar. Nenhum dado foi alterado." });
      if (code === "P0030") return respond(409, { code, error: "Confira os v\xEDnculos dos t\xEDtulos e selecione a respons\xE1vel de cada cliente sem carteira antes de concluir. Nenhum dado foi alterado." });
      if (code === "P0047") return respond(409, { code, error: "Confira o tipo de relat\xF3rio e a confer\xEAncia das aus\xEAncias antes de concluir a atualiza\xE7\xE3o. Nenhum dado foi alterado." });
      if (code === "54000") return respond(400, { code: "P0047", error: "A confer\xEAncia inclui mais de 5.000 t\xEDtulos ausentes. Confira o relat\xF3rio completo da origem antes de tentar novamente." });
      if (code === "23514" && result.payload?.message === IDENTITY_CHANGE) return respond(400, { code, error: IDENTITY_CHANGE });
      if (code === "22023" || code === "23514") return respond(400, { code, error: "A importa\xE7\xE3o foi recusada. Confira as linhas, a origem completa e os v\xEDnculos de cobradora dos clientes antes de concluir." });
      if (result.status === 401) return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
      if (result.status === 429) return respond(429, { code: "CR_RATE_LIMITED", error: "H\xE1 muitas solicita\xE7\xF5es em andamento. Aguarde antes de analisar novamente." });
      if (result.status === 408 || result.status === 504) return respond(504, { code: "CR_UPSTREAM_TIMEOUT", error: "O servi\xE7o de dados excedeu o tempo de resposta. Preserve o arquivo e confira o hist\xF3rico." });
      return respond(503, { error: SERVICE_FAILURE });
    }
    try {
      stage = "authenticate";
      const auth = await call("/auth/v1/user", { method: "GET" });
      if (!auth.ok) return auth.status === 401 || auth.status === 403 ? respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." }) : upstreamFailure(auth);
      if (typeof auth.payload?.id !== "string" || !UUID2.test(auth.payload.id)) throw new Error("invalid_identity");
      let sessionId;
      try {
        sessionId = verifiedSessionId(token, auth.payload.id);
      } catch {
        return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
      }
      stage = "authorize";
      const access = await call("/rest/v1/rpc/current_access", { data: {} });
      if (!access.ok) return upstreamFailure(access);
      if (access.payload?.profile?.id !== auth.payload.id || access.payload.profile.enabled !== true || !Array.isArray(access.payload.permissions) || !access.payload.permissions.some((permission) => permission?.resource === "contas_receber" && permission.action === "import")) {
        return respond(403, { code: "42501", error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      }
      let body;
      stage = "request";
      try {
        body = await readBody(request);
      } catch {
        return respond(400, { error: INVALID_REQUEST });
      }
      if (Object.keys(body).some((key) => !["action", "file_name", "file_base64", "complete", "previous_import_id", "mode", "title_mappings", "previous_financial_revision", "confirm_corrections", "collector_mappings", "full_report", "reference_date", "request_id"].includes(key)) || !["preview", "commit"].includes(body.action) || Object.hasOwn(body, "mode") && !["open", "received"].includes(body.mode) || !body.mode && (Object.hasOwn(body, "title_mappings") || Object.hasOwn(body, "previous_financial_revision") || Object.hasOwn(body, "confirm_corrections")) || body.mode !== "received" && Object.hasOwn(body, "confirm_corrections") || Object.hasOwn(body, "collector_mappings") && (body.mode !== "open" || !validCollectorMappings(body.collector_mappings)) || typeof body.file_name !== "string" || body.file_name.length < 1 || body.file_name.length > 250 || body.file_name !== body.file_name.trim() || /[/\\\u0000-\u001f\u007f]/.test(body.file_name)) return respond(400, { error: INVALID_REQUEST });
      const openReport = ["full_report", "reference_date", "request_id"].some((key) => Object.hasOwn(body, key));
      if (openReport && (body.mode !== "open" || typeof body.full_report !== "boolean" || !validOpenReportReference(body.reference_date) || Object.hasOwn(body, "request_id") && (typeof body.request_id !== "string" || !UUID2.test(body.request_id)) || body.action === "commit" && (typeof body.request_id !== "string" || !UUID2.test(body.request_id)))) return respond(400, { error: INVALID_REQUEST });
      if (openReport && !access.payload.permissions.some((permission) => permission?.resource === "importar_bases" && permission.action === "read")) return respond(403, { code: "42501", error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      if (Object.hasOwn(body, "title_mappings") && (!body.title_mappings || typeof body.title_mappings !== "object" || Array.isArray(body.title_mappings) || Object.keys(body.title_mappings).length > MAX_ROWS || Object.entries(body.title_mappings).some(([key, value]) => !/^[1-9]\d{0,3}$/.test(key) || Number(key) > MAX_ROWS || typeof value !== "string" || !(value === "NEW" || UUID2.test(value)))) || Object.hasOwn(body, "previous_financial_revision") && !validRevision(body.previous_financial_revision) || Object.hasOwn(body, "confirm_corrections") && typeof body.confirm_corrections !== "boolean") return respond(400, { error: INVALID_REQUEST });
      if (body.mode && !["read", "write"].every((action) => access.payload.permissions.some((permission) => permission?.resource === "contas_receber" && permission.action === action))) {
        return respond(403, { code: "42501", error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      }
      if (/\.xls$/i.test(body.file_name)) return respond(400, { error: "O formato .xls antigo ainda n\xE3o \xE9 aceito. No Excel, salve uma c\xF3pia como .xlsx." });
      if (!/\.(xlsx|xlsm|csv)$/i.test(body.file_name)) return respond(400, { error: "Selecione um arquivo .xlsx, .xlsm ou .csv." });
      if (body.action === "commit" && (body.complete !== true || body.mode && !validRevision(body.previous_financial_revision) || !(body.previous_import_id === null || typeof body.previous_import_id === "string" && UUID2.test(body.previous_import_id)))) return respond(400, { error: INVALID_REQUEST });
      let bytes;
      try {
        bytes = decodeFile(body.file_base64);
      } catch {
        return respond(400, { error: "O arquivo est\xE1 vazio, inv\xE1lido ou excede 2 MiB. Selecione novamente uma c\xF3pia do relat\xF3rio completo." });
      }
      stage = "parse";
      let parsed;
      try {
        let matrix, excel1904 = false, cellErrors = [];
        if (/\.csv$/i.test(body.file_name)) matrix = parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        else {
          const buffer = bytes.buffer;
          await validateWorkbookExpandedSize(buffer);
          if (typeof loadWorkbook !== "function") throw new Error("workbook_loader_unavailable");
          const loaded = await loadWorkbook(buffer);
          matrix = loaded.matrix;
          excel1904 = loaded.excel1904 === true;
          if (Array.isArray(loaded.errors)) cellErrors = loaded.errors.slice(0, 100);
        }
        if (!Array.isArray(matrix) || matrix.length > MAX_ROWS + 1 || matrix.some((row) => !Array.isArray(row) || row.length > 100)) {
          throw new Error("Planilha excede 5.000 linhas ou 100 colunas.");
        }
        if (body.mode !== "received" && matrix[0]?.some(receiptColumn)) throw new Error("Este arquivo cont\xE9m colunas de quita\xE7\xE3o. Selecione o modo Recebimentos para importar datas e valores efetivamente recebidos.");
        parsed = body.mode === "received" ? validateReceivablePaidRows(matrix, { excel1904 }) : validateReceivableRows(matrix, { excel1904 });
        const errors = mergeReceivableImportProblems(parsed.errors, cellErrors);
        parsed = { rows: errors.length ? [] : parsed.rows, errors };
      } catch (error) {
        if (signal.aborted) throw error;
        return respond(422, { error: "Importa\xE7\xE3o bloqueada. Nenhum dado foi alterado.", errors: [{ line: 0, column: "Arquivo", problem: safeMessage(error instanceof Error ? error.message : ""), correction: CORRECTION }] });
      }
      if (parsed.errors.length) return respond(422, { error: "Importa\xE7\xE3o bloqueada. Nenhum dado foi alterado.", errors: problemsFor(parsed.errors) });
      const withCollectors = openReport || Object.hasOwn(body, "collector_mappings");
      if (body.mode) {
        if (Object.keys(body.title_mappings ?? {}).some((key) => Number(key) > parsed.rows.length)) return respond(400, { error: INVALID_REQUEST });
        stage = "capabilities";
        const capabilities = await call("/rest/v1/rpc/receivables_import_capabilities", { data: {} });
        const required = openReport ? "open_report_sync" : body.mode === "open" ? "open_sync" : "received_import";
        if (!capabilities.ok && ["PGRST202", "42883", "42P01"].includes(capabilities.payload?.code) || capabilities.ok && (capabilities.payload?.[required] !== true || openReport && capabilities.payload?.open_report_version !== "047")) {
          return respond(409, { code: openReport ? "P0047" : body.mode === "open" ? "P0023" : "P0024", activation_required: true, error: `Ative a atualiza\xE7\xE3o de ${openReport ? "confer\xEAncia do relat\xF3rio completo" : body.mode === "open" ? "t\xEDtulos em aberto" : "recebimentos"} no banco de dados antes de usar este modo. Nenhum dado foi alterado.` });
        }
        if (!capabilities.ok) return upstreamFailure(capabilities);
      }
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (signal.aborted) throw new Error("request_timed_out");
      if (body.action === "preview") {
        stage = "preview";
        const path2 = openReport ? "preview_receivables_open_report" : withCollectors ? "preview_receivables_open_import_with_collectors" : body.mode === "open" ? "preview_receivables_open_import" : body.mode === "received" ? "preview_receivables_received_import" : "preview_receivables_import";
        const preview = await call(`/rest/v1/rpc/${path2}`, { data: { p_scope: "grupo-consolidado", p_rows: parsed.rows, ...body.mode ? { p_title_mappings: body.title_mappings ?? {} } : {}, ...withCollectors ? { p_collector_mappings: body.collector_mappings ?? {} } : {}, ...openReport ? { p_full_report: body.full_report, p_reference_date: body.reference_date } : {} } });
        if (!preview.ok && openReport && ["PGRST202", "42883", "42P01"].includes(preview.payload?.code)) return respond(409, { code: "P0047", activation_required: true, error: "Ative a atualiza\xE7\xE3o da confer\xEAncia de relat\xF3rios completos antes de concluir. Nenhum dado foi alterado." });
        if (!preview.ok && withCollectors && ["PGRST202", "42883"].includes(preview.payload?.code)) return respond(409, { code: "P0030", activation_required: true, error: "Ative a atualiza\xE7\xE3o das respons\xE1veis na importa\xE7\xE3o de t\xEDtulos em aberto antes de concluir. Nenhum dado foi alterado." });
        if (!preview.ok) return upstreamFailure(preview);
        stage = "preview_validation";
        if (!preview.payload || preview.payload.row_count !== parsed.rows.length) throw new Error("invalid_preview");
        if (body.mode) {
          const counters = body.mode === "open" ? ["new_count", "open_count", "changed_count", "pending_count", "validated_in_source_count", "conflict_count"] : ["new_count", "received_count", "matched_count", "correction_count", "historical_count", "conflict_count"];
          const outcomes = body.mode === "open" ? ["NEW", "UPDATE", "MATCHED", "AMBIGUOUS", "CONFLICT"] : ["NEW_RECEIPT", "MATCHED", "CORRECTION", "HISTORICAL", "AMBIGUOUS", "CONFLICT"];
          const checkedFields = body.mode === "received" ? [...sourceFields, "received_on", "received_amount_cents"] : sourceFields;
          if (preview.payload.mode !== body.mode || !validRevision(preview.payload.financial_revision) || !counters.every((key) => Number.isSafeInteger(preview.payload[key]) && preview.payload[key] >= 0) || typeof preview.payload.can_commit !== "boolean" || !Array.isArray(preview.payload.errors) || !Array.isArray(preview.payload.rows) || preview.payload.rows.length !== parsed.rows.length || preview.payload.rows.some((row, index) => !row || typeof row !== "object" || Array.isArray(row) || row.line !== index + 1 || !outcomes.includes(row.outcome) || !(row.title_id === null || typeof row.title_id === "string" && UUID2.test(row.title_id)) || checkedFields.some((key) => row[key] !== parsed.rows[index][key]))) throw new Error("invalid_preview");
        } else if (!Number.isSafeInteger(preview.payload.new_count) || !Number.isSafeInteger(preview.payload.open_count) || !Number.isSafeInteger(preview.payload.pending_count) || !Number.isSafeInteger(preview.payload.validated_in_source_count)) throw new Error("invalid_preview");
        if (withCollectors && !validCollectorPreview(preview.payload, parsed.rows)) throw new Error("invalid_collector_preview");
        if (openReport && !validOpenReportPreview(preview.payload, { fullReport: body.full_report, referenceDate: body.reference_date, rowCount: parsed.rows.length })) throw new Error("invalid_open_report_preview");
        return respond(200, { rows: body.mode ? preview.payload.rows : parsed.rows, preview: preview.payload, file_sha256: hash });
      }
      const path = openReport ? "commit_receivables_open_report_from_gateway" : withCollectors ? "commit_receivables_open_import_with_collectors_from_gateway" : body.mode === "open" ? "commit_receivables_open_import_from_gateway" : body.mode === "received" ? "commit_receivables_received_import_from_gateway" : "commit_receivables_import_from_gateway";
      stage = "commit";
      const committed = await call(`/rest/v1/rpc/${path}`, { service: true, data: {
        p_user_id: auth.payload.id,
        p_session_id: sessionId,
        p_scope: "grupo-consolidado",
        p_file_name: body.file_name,
        p_file_sha256: hash,
        p_file_base64: body.file_base64,
        p_rows: parsed.rows,
        p_previous_import_id: body.previous_import_id,
        ...body.mode ? { p_title_mappings: body.title_mappings ?? {}, p_previous_financial_revision: body.previous_financial_revision } : { p_complete: true },
        ...body.mode === "received" ? { p_confirm_corrections: body.confirm_corrections ?? false } : {},
        ...withCollectors ? { p_collector_mappings: body.collector_mappings ?? {} } : {},
        ...openReport ? { p_full_report: body.full_report, p_reference_date: body.reference_date, p_request_id: body.request_id } : {}
      } });
      if (!committed.ok && openReport && ["PGRST202", "42883", "42P01"].includes(committed.payload?.code)) return respond(409, { code: "P0047", activation_required: true, error: "Ative a atualiza\xE7\xE3o da confer\xEAncia de relat\xF3rios completos antes de concluir. Nenhum dado foi alterado." });
      if (!committed.ok && withCollectors && ["PGRST202", "42883"].includes(committed.payload?.code)) return respond(409, { code: "P0030", activation_required: true, error: "Ative a atualiza\xE7\xE3o das respons\xE1veis na importa\xE7\xE3o de t\xEDtulos em aberto antes de concluir. Nenhum dado foi alterado." });
      if (!committed.ok) return upstreamFailure(committed);
      stage = "commit_validation";
      if (!committed.payload || committed.payload.row_count !== parsed.rows.length || typeof committed.payload.import_id !== "string" || !UUID2.test(committed.payload.import_id) || body.mode && committed.payload.mode !== body.mode) throw new Error("invalid_commit_response");
      if (withCollectors && (committed.payload.collector_assignment_version !== "030" || !["assigned_title_count", "assigned_customer_count"].every((key) => Number.isSafeInteger(committed.payload[key]) && committed.payload[key] >= 0) || committed.payload.assigned_customer_count > committed.payload.assigned_title_count)) throw new Error("invalid_collector_commit_response");
      if (openReport && !validOpenReportCommit(committed.payload, { fullReport: body.full_report, referenceDate: body.reference_date, requestId: body.request_id, rowCount: parsed.rows.length })) throw new Error("invalid_open_report_commit_response");
      return respond(200, committed.payload);
    } catch (error) {
      if (signal.aborted || deadline.aborted) return respond(504, { code: "CR_REQUEST_TIMEOUT", error: "A opera\xE7\xE3o excedeu o tempo de resposta. Preserve o arquivo e confira o hist\xF3rico antes de tentar novamente." });
      if (stage === "preview_validation") return respond(502, { code: "CR_INVALID_PREVIEW", error: "O servi\xE7o retornou uma an\xE1lise incompat\xEDvel. Atualize a fun\xE7\xE3o de importa\xE7\xE3o antes de tentar novamente." });
      if (stage === "commit_validation" || error instanceof Error && error.message === "invalid_identity") return respond(502, { code: "CR_INVALID_RESPONSE", error: SERVICE_FAILURE });
      return respond(503, { error: SERVICE_FAILURE });
    }
  };
}

// supabase/functions/receivables-import/index.ts
Deno.serve(createReceivablesGateway({
  env: (name) => Deno.env.get(name),
  // The handler validates actual ZIP expansion before calling this adapter.
  loadWorkbook: async (buffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const populated = workbook.worksheets.filter((sheet2) => sheet2.actualRowCount > 0);
    if (populated.length !== 1) throw new Error("A c\xF3pia para importa\xE7\xE3o deve conter uma \xFAnica aba com dados.");
    const sheet = populated[0];
    if (sheet.rowCount > 5001 || sheet.columnCount > 100) throw new Error("Planilha excede 5.000 linhas ou 100 colunas.");
    const identifierColumns = [];
    sheet.getRow(1).eachCell((cell, column) => {
      if (isReceivableIdentifierHeader(cell.value)) identifierColumns.push(column);
    });
    const matrix = [], errors = [];
    for (let index = 1; index <= sheet.rowCount; index++) {
      const source = sheet.getRow(index), values = source.values.slice(1);
      if (index > 1) for (const column of identifierColumns) {
        const cell = source.getCell(column), result = readReceivableIdentifierCellResult(cell.value, cell.numFmt, index, column);
        values[column - 1] = result.value;
        if (result.error && errors.length < 100) errors.push(result.error);
      }
      matrix.push(values);
    }
    return { matrix, excel1904: Boolean(workbook.properties.date1904), errors };
  },
  log: (event) => console.warn(JSON.stringify(event))
}));
