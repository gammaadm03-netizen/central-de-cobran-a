// supabase/functions/payables-import/index.ts
import ExcelJS from "npm:exceljs@4.4.0";

// src/lib/payable-bank-rules.mjs
function normalizePaidBankDescription(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().trim().replace(/\s+/g, " ");
}
function isInternalCashBank(value) {
  return normalizePaidBankDescription(value) === "CAIXA INTERNO";
}

// src/lib/payables-parser.mjs
var MAX_FILE_BYTES = 2 * 1024 * 1024;
var MAX_ROWS = 5e3;
var REQUIRED = ["entry_number", "description", "due_date", "amount_cents", "plan", "branch"];
var COLUMN_LABELS = { entry_number: "N\xBA lan\xE7amento", description: "Hist\xF3rico / Favorecido", due_date: "Vencimento", amount_cents: "Valor", plan: "Plano de Contas", branch: "Filial", bank_account: "Banco / Conta", issued_on: "Emiss\xE3o", source_status: "Status / Situa\xE7\xE3o", cheque_number: "Cheque: n\xFAmero" };
var normalize = (value) => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
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
var ERP_TIMESTAMP_HEADERS = /* @__PURE__ */ new Set(["EMISSAODATA", "VENCIMENTODATA"]);
var PAID_DATE_HEADERS = /* @__PURE__ */ new Set(["QUITACAODATADOPAGAMENTO", "DATADOPAGAMENTO", "DATAPAGAMENTO", "PAGAMENTODATA"]);
var PAID_TIMESTAMP_HEADERS = /* @__PURE__ */ new Set(["QUITACAODATADOPAGAMENTO", "PAGAMENTODATA"]);
var PAID_COLUMN_LABELS = { ...COLUMN_LABELS, paid_on: "Quita\xE7\xE3o: data do pagamento" };
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
  const text3 = String(value ?? "").trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text3);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text3);
  if (!br && !iso) throw new Error("Use dd/mm/aaaa ou aaaa-mm-dd; datas abreviadas s\xE3o amb\xEDguas.");
  return br ? civil(+br[3], +br[2], +br[1]) : civil(+iso[1], +iso[2], +iso[3]);
}
function parsePayableErpDate(value, excel1904) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("Data inv\xE1lida.");
    return civil(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 1 || value > 2958465) throw new Error("Data Excel inv\xE1lida.");
    return parseCivilDate(Math.floor(value), excel1904);
  }
  const text3 = String(value ?? "").trim();
  const timestamp = /^(\d{2}\/\d{2}\/\d{4}) +(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text3);
  if (!timestamp) return parseCivilDate(value, excel1904);
  if (+timestamp[2] > 23 || +timestamp[3] > 59 || +(timestamp[4] ?? 0) > 59) throw new Error("Hor\xE1rio inv\xE1lido. Use hh:mm ou hh:mm:ss, entre 00:00:00 e 23:59:59.");
  return parseCivilDate(timestamp[1], excel1904);
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
  let text3 = String(value ?? "").trim().replace(/^R\$\s*/, "");
  if (!text3) throw new Error("Valor obrigat\xF3rio.");
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text3)) throw new Error("Use valor brasileiro, por exemplo 1.234,56, com at\xE9 duas casas decimais.");
  text3 = text3.replaceAll(".", "");
  const [integer, decimal = ""] = text3.split(",");
  const cents = BigInt(integer) * 100n + BigInt(decimal.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Valor excede o limite seguro.");
  return Number(cents);
}
function parseCsv(text3, { maxRows = MAX_ROWS + 1 } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS + 21) throw new Error("Limite de linhas do CSV inv\xE1lido.");
  text3 = text3.replace(/^\uFEFF/, "");
  if (text3.includes("\0")) throw new Error("CSV cont\xE9m bytes inv\xE1lidos. Salve uma c\xF3pia em UTF-8.");
  const sample = text3.split(/\r?\n/, 1)[0];
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
  for (let index = 0; index < text3.length; index++) {
    const character = text3[index];
    if (inQuote) {
      if (character === '"') {
        if (text3[index + 1] === '"') {
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
      if (character === "\r" && text3[index + 1] === "\n") index++;
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
function scalar(value) {
  if (value === null || value === void 0) return "";
  if (typeof value === "object" && !(value instanceof Date)) {
    if ("formula" in value || "sharedFormula" in value) throw new Error("F\xF3rmula n\xE3o permitida. Salve uma c\xF3pia apenas com valores.");
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value && "hyperlink" in value) return value.text;
    throw new Error("C\xE9lula com conte\xFAdo n\xE3o suportado. Use somente valores.");
  }
  if (typeof value === "string" && /^\s*[=+@]/.test(value)) throw new Error("Conte\xFAdo interpret\xE1vel como f\xF3rmula. Salve somente valores.");
  return value;
}
var INVALID_CHEQUE = "N\xFAmero de cheque inv\xE1lido. Use texto ou n\xFAmero inteiro n\xE3o negativo, sem nota\xE7\xE3o cient\xEDfica.";
var UNSUPPORTED_CHEQUE_FORMAT = "Formato da c\xE9lula do cheque n\xE3o suportado. No Excel, formate o n\xFAmero do cheque como Texto ou use somente zeros, como 000000.";
function parseChequeNumber(value) {
  const primitive = scalar(value);
  if (typeof primitive === "number") {
    if (!Number.isSafeInteger(primitive) || primitive < 0) throw new Error(INVALID_CHEQUE);
    return String(primitive);
  }
  if (typeof primitive !== "string") throw new Error(INVALID_CHEQUE);
  const text3 = primitive.trim();
  if (text3.length > 150) throw new Error("Limite de 150 caracteres excedido.");
  if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)[eE][+-]?\d+$/.test(text3) || /^-\d+(?:[.,]\d+)?$/.test(text3) || /^\d+[.,]\d+$/.test(text3) || /[\u0000-\u001f\u007f]/.test(text3)) throw new Error(INVALID_CHEQUE);
  return text3;
}
function isChequeNumberHeader(value) {
  return headerMap.get(normalize(scalar(value))) === "cheque_number";
}
function readPayableChequeCell(value, numFmt) {
  if (value instanceof Date) throw new Error(UNSUPPORTED_CHEQUE_FORMAT);
  const text3 = parseChequeNumber(value);
  if (typeof value !== "number") return text3;
  const format = String(numFmt ?? "").trim();
  if (!format || format.toUpperCase() === "GENERAL" || format === "@") return text3;
  if (!/^0+$/.test(format)) throw new Error(UNSUPPORTED_CHEQUE_FORMAT);
  if (format.length > 150) throw new Error("Limite de 150 caracteres excedido.");
  return text3.padStart(format.length, "0");
}
function validatePayableRows(matrix, { excel1904 = false } = {}) {
  const errors = [], rows = [];
  if (!matrix.length) return { rows, errors: [{ line: 1, column: "Arquivo", problem: "Arquivo vazio.", correction: "Exporte o relat\xF3rio completo com os cabe\xE7alhos." }] };
  const columns = /* @__PURE__ */ new Map(), timestampColumns = /* @__PURE__ */ new Set();
  matrix[0].forEach((value, index) => {
    let key;
    try {
      const normalizedHeader = normalize(scalar(value));
      key = headerMap.get(normalizedHeader);
      if (ERP_TIMESTAMP_HEADERS.has(normalizedHeader)) timestampColumns.add(index);
    } catch {
      errors.push({ line: 1, column: "Cabe\xE7alho", problem: "Cabe\xE7alho inv\xE1lido.", correction: "Use nomes de colunas sem f\xF3rmulas." });
      return;
    }
    if (key && columns.has(key)) errors.push({ line: 1, column: COLUMN_LABELS[key], problem: "Coluna duplicada ou amb\xEDgua.", correction: "Mantenha uma \xFAnica coluna para este campo." });
    else if (key) columns.set(key, index);
  });
  for (const key of REQUIRED) if (!columns.has(key)) errors.push({ line: 1, column: COLUMN_LABELS[key], problem: "Coluna obrigat\xF3ria ausente.", correction: `Inclua a coluna ${COLUMN_LABELS[key]}.` });
  if (errors.length) return { rows, errors };
  const keys = /* @__PURE__ */ new Set();
  let total = 0, nonempty = 0;
  for (let index = 1; index < matrix.length; index++) {
    const source = matrix[index];
    if (source.every((value) => value === null || value === void 0 || String(value).trim() === "")) continue;
    nonempty++;
    if (nonempty > MAX_ROWS) {
      errors.push({ line: index + 1, column: "Arquivo", problem: "Mais de 5.000 linhas.", correction: "Exporte uma origem completa dentro do limite." });
      break;
    }
    const row = { entry_number: "", description: "", due_date: "", amount_cents: 0, plan: "", bank_account: "", branch: "", issued_on: null, source_status: "" };
    const before = errors.length;
    if (source.length > matrix[0].length && source.slice(matrix[0].length).some((value) => value !== null && value !== void 0 && String(value).trim())) errors.push({ line: index + 1, column: "Arquivo", problem: "H\xE1 valores fora das colunas do cabe\xE7alho.", correction: "Confira delimitadores e cabe\xE7alhos; valores com v\xEDrgula em CSV devem estar entre aspas." });
    source.forEach((value, column) => {
      if (!Array.from(columns.values()).includes(column)) {
        try {
          scalar(value);
        } catch (error) {
          errors.push({ line: index + 1, column: `Coluna ${column + 1}`, problem: error.message, correction: "Salve uma c\xF3pia somente com valores, sem f\xF3rmulas." });
        }
      }
    });
    for (const [key, column] of columns) {
      try {
        const value = scalar(source[column]);
        if (key === "amount_cents") row[key] = parseMoneyCents(value);
        else if (key === "cheque_number") row[key] = parseChequeNumber(value);
        else if (key === "due_date") row[key] = timestampColumns.has(column) ? parsePayableErpDate(value, excel1904) : parseCivilDate(value, excel1904);
        else if (key === "issued_on") row[key] = String(value).trim() ? timestampColumns.has(column) ? parsePayableErpDate(value, excel1904) : parseCivilDate(value, excel1904) : null;
        else {
          row[key] = String(value ?? "").trim().replace(/\s+/g, " ");
          if (REQUIRED.includes(key) && !row[key]) throw new Error("Campo obrigat\xF3rio vazio.");
          const maximum = key === "description" ? 1500 : ["entry_number", "branch", "source_status"].includes(key) ? 150 : 300;
          if (row[key].length > maximum) throw new Error(`Limite de ${maximum} caracteres excedido.`);
        }
      } catch (error) {
        errors.push({ line: index + 1, column: COLUMN_LABELS[key], problem: error.message, correction: "Corrija a c\xE9lula no arquivo original e selecione uma nova c\xF3pia." });
      }
    }
    const identity2 = JSON.stringify([row.branch.toUpperCase(), row.entry_number.toUpperCase()]);
    if (errors.length === before && keys.has(identity2)) errors.push({ line: index + 1, column: "N\xBA lan\xE7amento", problem: "Chave de t\xEDtulo duplicada na mesma base.", correction: "Mantenha uma \xFAnica linha por filial e n\xFAmero de lan\xE7amento. Valor e vencimento atualizam o mesmo t\xEDtulo; n\xE3o identificam outra parcela." });
    if (errors.length === before) {
      total += row.amount_cents;
      if (!Number.isSafeInteger(total)) errors.push({ line: index + 1, column: "Valor", problem: "Total do relat\xF3rio excede o limite de precis\xE3o.", correction: "Confira valores e origem da base antes de importar." });
      else {
        keys.add(identity2);
        rows.push(row);
      }
    }
    if (errors.length >= 100) break;
  }
  if (!rows.length && !errors.length) errors.push({ line: 2, column: "Arquivo", problem: "N\xE3o h\xE1 t\xEDtulos no relat\xF3rio.", correction: "Selecione um relat\xF3rio completo com lan\xE7amentos; base vazia n\xE3o pode baixar t\xEDtulos." });
  return { rows: errors.length ? [] : rows, errors };
}
function validatePayableDailyRows(matrix, { excel1904 = false, allowEmptyCheques = false, allowEmptyReport = false } = {}) {
  const parsed = validatePayableRows(matrix, { excel1904 });
  if (allowEmptyCheques !== true && allowEmptyReport !== true) return parsed;
  if (parsed.errors.length === 1 && parsed.errors[0].line === 2 && parsed.errors[0].column === "Arquivo" && parsed.errors[0].problem === "N\xE3o h\xE1 t\xEDtulos no relat\xF3rio.") return { rows: [], errors: [] };
  if (!parsed.errors.length && parsed.rows.length > 0) return { rows: [], errors: [{
    line: 0,
    column: allowEmptyReport === true ? "Declara\xE7\xE3o de relat\xF3rio sem t\xEDtulos" : "Declara\xE7\xE3o de cheques",
    problem: allowEmptyReport === true ? "O relat\xF3rio cont\xE9m t\xEDtulos. Desmarque a declara\xE7\xE3o de relat\xF3rio sem t\xEDtulos em aberto." : "O relat\xF3rio cont\xE9m t\xEDtulos. Desmarque a declara\xE7\xE3o de posi\xE7\xE3o sem cheques pendentes.",
    correction: "Confira o conte\xFAdo do arquivo e a declara\xE7\xE3o antes de analisar novamente."
  }] };
  return parsed;
}
function validatePayablePaidRows(matrix, { excel1904 = false, today, useExplicitPaymentDate = true, allowInternalCashWriteoff = false, columnRulesVersion } = {}) {
  const errors = [], rows = [];
  if (today !== void 0) {
    try {
      if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today) || parseCivilDate(today) !== today) throw new Error("invalid-today");
    } catch {
      return { rows, errors: [{ line: 0, column: "Arquivo", problem: "A data de refer\xEAncia da confer\xEAncia \xE9 inv\xE1lida.", correction: "Atualize a p\xE1gina antes de analisar novamente." }] };
    }
  }
  if (!matrix.length) return { rows, errors: [{ line: 1, column: "Arquivo", problem: "Arquivo vazio.", correction: "Exporte o relat\xF3rio de pagamentos com os cabe\xE7alhos." }] };
  const columns = /* @__PURE__ */ new Map(), timestampColumns = /* @__PURE__ */ new Set();
  matrix[0].forEach((value, index) => {
    let key;
    try {
      const normalizedHeader = normalize(scalar(value));
      key = useExplicitPaymentDate !== false && PAID_DATE_HEADERS.has(normalizedHeader) ? "paid_on" : headerMap.get(normalizedHeader);
      if (ERP_TIMESTAMP_HEADERS.has(normalizedHeader) || useExplicitPaymentDate !== false && PAID_TIMESTAMP_HEADERS.has(normalizedHeader)) timestampColumns.add(index);
    } catch {
      errors.push({ line: 1, column: "Cabe\xE7alho", problem: "Cabe\xE7alho inv\xE1lido.", correction: "Use nomes de colunas sem f\xF3rmulas." });
      return;
    }
    if (key && columns.has(key)) errors.push({ line: 1, column: PAID_COLUMN_LABELS[key], problem: "Coluna duplicada ou amb\xEDgua.", correction: "Mantenha uma \xFAnica coluna para este campo." });
    else if (key) columns.set(key, index);
  });
  const paymentDateKey = columns.has("paid_on") ? "paid_on" : "due_date";
  const required = ["entry_number", "branch", paymentDateKey, "amount_cents", "bank_account"];
  for (const key of required) if (!columns.has(key)) errors.push({ line: 1, column: PAID_COLUMN_LABELS[key], problem: "Coluna obrigat\xF3ria ausente.", correction: `Inclua a coluna ${PAID_COLUMN_LABELS[key]}; n\xE3o \xE9 poss\xEDvel deduzir dados do pagamento.` });
  if (errors.length) return { rows, errors };
  const used = /* @__PURE__ */ new Set([...required, "source_status", "cheque_number", "description", "plan", "issued_on"]);
  const usedColumns = new Set([...columns].filter(([key]) => used.has(key)).map(([, column]) => column));
  const identities = /* @__PURE__ */ new Set();
  let total = 0, nonempty = 0;
  for (let index = 1; index < matrix.length; index++) {
    const source = matrix[index];
    if (source.every((value) => value === null || value === void 0 || String(value).trim() === "")) continue;
    nonempty++;
    if (nonempty > MAX_ROWS) {
      errors.push({ line: index + 1, column: "Arquivo", problem: "Mais de 5.000 linhas.", correction: "Exporte uma origem completa dentro do limite." });
      break;
    }
    let internalCash = false, cashDateNeedsTitleLookup = false;
    if (allowInternalCashWriteoff === true) {
      try {
        internalCash = isInternalCashBank(scalar(source[columns.get("bank_account")]));
      } catch {
      }
    }
    if (internalCash && columnRulesVersion === "059") {
      try {
        const cent = parseMoneyCents(scalar(source[columns.get("amount_cents")])) === 1;
        const hasChequeColumn = columns.has("cheque_number");
        const cheque = hasChequeColumn && parseChequeNumber(source[columns.get("cheque_number")]);
        const suppliedDate = String(scalar(source[columns.get(paymentDateKey)]) ?? "").trim() !== "";
        cashDateNeedsTitleLookup = !cent && !hasChequeColumn && suppliedDate;
        if (!cent && (cheque || cashDateNeedsTitleLookup)) internalCash = false;
      } catch {
      }
    }
    const row = { branch: "", entry_number: "", source_status: "PAGO", paid_on: internalCash ? null : "", amount_paid_cents: 0, paid_bank: "" };
    const before = errors.length;
    if (source.length > matrix[0].length && source.slice(matrix[0].length).some((value) => value !== null && value !== void 0 && String(value).trim())) errors.push({ line: index + 1, column: "Arquivo", problem: "H\xE1 valores fora das colunas do cabe\xE7alho.", correction: "Confira delimitadores e cabe\xE7alhos; valores com v\xEDrgula em CSV devem estar entre aspas." });
    source.forEach((value, column) => {
      if (!usedColumns.has(column)) {
        try {
          scalar(value);
        } catch (error) {
          errors.push({ line: index + 1, column: `Coluna ${column + 1}`, problem: error.message, correction: "Salve uma c\xF3pia somente com valores, sem f\xF3rmulas." });
        }
      }
    });
    for (const [key, column] of columns) {
      if (!used.has(key)) continue;
      try {
        const value = scalar(source[column]);
        if (key === "amount_cents") {
          row.amount_paid_cents = parseMoneyCents(value);
          if (row.amount_paid_cents <= 0) throw new Error("O valor pago deve ser maior que zero.");
        } else if (key === paymentDateKey) {
          if (internalCash) row.paid_on = null;
          else {
            row.paid_on = timestampColumns.has(column) ? parsePayableErpDate(value, excel1904) : parseCivilDate(value, excel1904);
            if (today !== void 0 && row.paid_on > today && !cashDateNeedsTitleLookup) throw new Error("A data do pagamento \xE9 futura.");
          }
        } else if (key === "cheque_number") row.cheque_number = parseChequeNumber(value);
        else if (key === "issued_on") row.issued_on = String(value).trim() ? timestampColumns.has(column) ? parsePayableErpDate(value, excel1904) : parseCivilDate(value, excel1904) : null;
        else {
          const text3 = String(value ?? "").trim().replace(/\s+/g, " ");
          if (key === "source_status") {
            if (!["", "PAGO", "CHEQUE", "QUITADO", "LIQUIDADO", "COMPENSADO"].includes(text3.toUpperCase())) throw new Error("O relat\xF3rio de pagamentos cont\xE9m situa\xE7\xE3o incompat\xEDvel com pagamento confirmado.");
          } else if (key === "description" || key === "plan") {
            const maximum = key === "description" ? 1500 : 300;
            if (text3.length > maximum) throw new Error(`Limite de ${maximum} caracteres excedido.`);
            if (text3) row[key] = text3;
          } else {
            if (!text3) throw new Error("Campo obrigat\xF3rio vazio.");
            const maximum = key === "bank_account" ? 300 : 150;
            if (text3.length > maximum) throw new Error(`Limite de ${maximum} caracteres excedido.`);
            if (key === "bank_account") row.paid_bank = text3;
            else row[key] = text3;
          }
        }
      } catch (error) {
        errors.push({ line: index + 1, column: PAID_COLUMN_LABELS[key], problem: error.message, correction: error.message === "A data do pagamento \xE9 futura." ? "Confira a data efetiva no sistema de origem; pagamentos agendados n\xE3o confirmam pagamento realizado." : "Confira o comprovante e corrija o relat\xF3rio de pagamentos; n\xE3o use datas ou bancos previstos." });
      }
    }
    const identity2 = JSON.stringify([row.branch.toUpperCase(), row.entry_number.toUpperCase()]);
    if (errors.length === before && identities.has(identity2)) errors.push({ line: index + 1, column: "N\xBA lan\xE7amento", problem: "Lan\xE7amento repetido no relat\xF3rio de pagamentos.", correction: "Mantenha um \xFAnico pagamento integral por filial e n\xFAmero de lan\xE7amento." });
    if (errors.length === before) {
      total += row.amount_paid_cents;
      if (!Number.isSafeInteger(total)) errors.push({ line: index + 1, column: "Valor", problem: "Total do relat\xF3rio excede o limite de precis\xE3o.", correction: "Confira valores e origem da base antes de importar." });
      else {
        identities.add(identity2);
        rows.push(row);
      }
    }
    if (errors.length >= 100) break;
  }
  if (!rows.length && !errors.length) errors.push({ line: 2, column: "Arquivo", problem: "N\xE3o h\xE1 t\xEDtulos no relat\xF3rio.", correction: "Selecione o relat\xF3rio de pagamentos com lan\xE7amentos; nenhum pagamento ser\xE1 deduzido de uma base vazia." });
  return { rows: errors.length ? [] : rows, errors };
}

// supabase/functions/payables-import/reconciliation.mjs
var UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
var ROW_KEY = /^row:([1-9]\d{0,3})$/;
var ACTIONS = /* @__PURE__ */ new Set(["WRITE_OFF", "PAID", "REOPEN"]);
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var safeAmount = (value) => Number.isSafeInteger(value) && value >= 0;
var text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
var identity = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
function validReconciliationDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "2199-12-31") return false;
  const date = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validResolutionKey(value, rowCount = 5e3) {
  if (typeof value !== "string") return false;
  const row = ROW_KEY.exec(value);
  return row ? Number(row[1]) <= rowCount : value.startsWith("title:") && UUID.test(value.slice(6));
}
function validResolutionChoices(value, rowCount = 5e3) {
  if (!object(value) || Object.keys(value).length > 1e4) return false;
  return Object.entries(value).every(([key, choice]) => {
    if (!validResolutionKey(key, rowCount) || !object(choice) || !ACTIONS.has(choice.action) || !text(choice.reason, 1e3) || choice.reason !== choice.reason.trim()) return false;
    const fields = choice.action === "PAID" ? ["action", "reason", "paid_on", "amount_paid_cents", "bank_account_id"] : ["action", "reason"];
    if (Object.keys(choice).some((field) => !fields.includes(field))) return false;
    return choice.action !== "PAID" || validReconciliationDate(choice.paid_on) && Number.isSafeInteger(choice.amount_paid_cents) && choice.amount_paid_cents > 0 && typeof choice.bank_account_id === "string" && UUID.test(choice.bank_account_id);
  });
}
function validColumnRulesPaidPreview(preview, sourceRows) {
  if (!object(preview) || preview.column_rules_version !== "059" || !Array.isArray(sourceRows) || !Array.isArray(preview.rows) || preview.rows.length !== sourceRows.length || !Array.isArray(preview.bank_options) || !(preview.cheque_payment_bank_id === null || typeof preview.cheque_payment_bank_id === "string" && UUID.test(preview.cheque_payment_bank_id))) return false;
  const canonical = preview.bank_options.filter((bank) => object(bank) && bank.account_type === "BANK" && normalizePaidBankDescription(bank.display_name) === "BRADESCO F2G");
  if (preview.cheque_payment_bank_id !== (canonical.length === 1 ? canonical[0].id : null)) return false;
  return preview.rows.every((row, index) => {
    const source = sourceRows[index];
    if (!object(row) || !["CHEQUE_F2G", "SOURCE_BANK"].includes(row.payment_bank_rule) || typeof source.cheque_number === "string" && source.cheque_number.trim() && row.cheque_number !== source.cheque_number || typeof source.cheque_number === "string" && source.cheque_number.trim() && row.payment_bank_rule !== "CHEQUE_F2G") return false;
    if (row.payment_bank_rule !== "CHEQUE_F2G" || row.amount_paid_cents === 1) return true;
    if (row.bank_account_id === null) return !preview.can_commit && !["NEW_PAYMENT", "MATCHED", "CORRECTION"].includes(row.outcome);
    return row.bank_account_id === preview.cheque_payment_bank_id && canonical.length === 1;
  });
}
function validReconciliationPreview(preview, { rowCount, mode, fullReport, sourceRows, resolutionChoices = {}, bankRulesVersion, columnRulesVersion } = {}) {
  const internalCashAllowed = bankRulesVersion === "050" && mode === "payments";
  const columnRules = columnRulesVersion === "059" && internalCashAllowed;
  if (columnRulesVersion !== void 0 && !columnRules || columnRules && !validColumnRulesPaidPreview(preview, sourceRows)) return false;
  if (bankRulesVersion !== void 0 && !internalCashAllowed) return false;
  if (internalCashAllowed && (!Array.isArray(sourceRows) || sourceRows.length !== rowCount || sourceRows.some((row) => !row || !Number.isSafeInteger(row.amount_paid_cents) || row.amount_paid_cents <= 0 || !text(row.paid_bank, 300) || (isInternalCashBank(row.paid_bank) ? columnRules ? row.paid_on !== null && !validReconciliationDate(row.paid_on) : row.paid_on !== null : !validReconciliationDate(row.paid_on))))) return false;
  if (!object(preview) || preview.reconciliation_version !== "043" || preview.row_count !== rowCount || preview.mode !== mode || !text(preview.financial_revision, 256) || preview.financial_revision !== preview.financial_revision.trim() || typeof preview.can_commit !== "boolean" || !Array.isArray(preview.reconciliation_items) || preview.reconciliation_items.length > 15e3 || !Array.isArray(preview.resolution_errors) || preview.resolution_errors.length > 15e3 || preview.can_commit && preview.resolution_errors.length !== 0 || mode === "forecast" && preview.full_report !== fullReport) return false;
  const keys = /* @__PURE__ */ new Set();
  for (const item of preview.reconciliation_items) {
    if (!object(item) || !validResolutionKey(item.key, rowCount) || keys.has(item.key) || !["CENT", "MISSING", "REAPPEARED", ...internalCashAllowed ? ["INTERNAL_CASH"] : []].includes(item.kind) || !(item.line === null || Number.isSafeInteger(item.line) && item.line >= 1 && item.line <= rowCount) || !(item.title_id === null || typeof item.title_id === "string" && UUID.test(item.title_id)) || !text(item.branch, 300) || !text(item.entry_number, 300) || typeof item.description !== "string" || item.description.length > 1500 || !(validReconciliationDate(item.due_date) || !preview.can_commit && item.title_id === null && item.due_date === null) || !(safeAmount(item.amount_cents) || !preview.can_commit && item.title_id === null && item.amount_cents === null) || !Array.isArray(item.allowed_actions) || item.allowed_actions.length > 3 || new Set(item.allowed_actions).size !== item.allowed_actions.length || item.allowed_actions.some((action) => !ACTIONS.has(action)) || !(item.selected_action === null || item.allowed_actions.includes(item.selected_action)) || typeof item.requires_resolution !== "boolean" || !(item.problem === null || typeof item.problem === "string" && item.problem.length <= 2e3) || ["CENT", "INTERNAL_CASH"].includes(item.kind) && item.allowed_actions.some((action) => action !== "WRITE_OFF")) return false;
    if (preview.can_commit && item.requires_resolution && !item.selected_action) return false;
    if (item.selected_action !== (resolutionChoices[item.key]?.action ?? null)) return false;
    if (preview.can_commit && item.problem) return false;
    if (["CENT", "INTERNAL_CASH"].includes(item.kind)) {
      if (item.line === null || item.key !== `row:${item.line}`) return false;
    } else if (item.title_id === null || item.key !== `title:${item.title_id}` || mode !== "forecast" || item.kind === "MISSING" && (!fullReport || item.line !== null) || item.kind === "REAPPEARED" && item.line === null) return false;
    if (Array.isArray(sourceRows) && item.line !== null) {
      const row = sourceRows[item.line - 1];
      if (!row || identity(item.branch) !== identity(row.branch) || identity(item.entry_number) !== identity(row.entry_number) || item.kind === "CENT" && (mode === "payments" ? row.amount_paid_cents : row.amount_cents) !== 1 || item.kind === "INTERNAL_CASH" && (!isInternalCashBank(row.paid_bank) || columnRules && preview.rows[item.line - 1]?.payment_bank_rule === "CHEQUE_F2G" || row.amount_paid_cents === 1 || item.source_amount_cents !== row.amount_paid_cents)) return false;
      if (internalCashAllowed && ["CENT", "INTERNAL_CASH"].includes(item.kind) && (item.source_amount_cents !== row.amount_paid_cents || item.title_id !== null && (item.requires_resolution !== true || item.allowed_actions.length !== 1 || preview.can_commit && (item.selected_action !== "WRITE_OFF" || resolutionChoices[item.key]?.action !== "WRITE_OFF")))) return false;
    }
    keys.add(item.key);
  }
  if (Array.isArray(sourceRows) && sourceRows.some((row, index) => {
    const cent = (mode === "payments" ? row.amount_paid_cents : row.amount_cents) === 1;
    const cash = internalCashAllowed && isInternalCashBank(row.paid_bank) && !(columnRules && preview.rows[index]?.payment_bank_rule === "CHEQUE_F2G");
    return (cent || cash) && !preview.reconciliation_items.some((item) => item.key === `row:${index + 1}` && item.kind === (cent ? "CENT" : "INTERNAL_CASH"));
  })) return false;
  if (preview.can_commit && Object.keys(resolutionChoices).some((key) => !keys.has(key))) return false;
  return true;
}

// supabase/functions/payables-import/daily-reconciliation.mjs
var UUID2 = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
var object2 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var text2 = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
var uuid = (value) => typeof value === "string" && UUID2.test(value);
var count = (value) => Number.isSafeInteger(value) && value >= 0;
var mapping = (value, max, keyMax, validValue) => object2(value) && Object.keys(value).length <= max && Object.entries(value).every(([key, item]) => text2(key, keyMax) && validValue(item));
var DAILY_REPORT_VERSION = "060";
function isDailyCheque(row) {
  return String(row.source_status ?? "").trim().toUpperCase() === "CHEQUE" || typeof row.cheque_number === "string" && row.cheque_number.trim() !== "";
}
function dailyReportSourceRows(rows, kind) {
  return rows;
}
function validDailyRequest(body) {
  const fields = [
    "action",
    "mode",
    "daily_report_version",
    "report_kind",
    "file_name",
    "file_base64",
    "mappings",
    "bank_mappings",
    "resolution_choices",
    "complete",
    "previous_import_id",
    "previous_financial_revision",
    "expected_report_date",
    "request_id",
    "empty_report_confirmed"
  ];
  if (!object2(body) || Object.keys(body).some((key) => !fields.includes(key)) || body.mode !== "daily" || body.daily_report_version !== DAILY_REPORT_VERSION || body.report_kind !== "ALL" || !["preview", "commit"].includes(body.action) || !text2(body.file_name, 250) || /[/\\]/.test(body.file_name) || Object.hasOwn(body, "empty_report_confirmed") && typeof body.empty_report_confirmed !== "boolean" || !mapping(body.mappings ?? {}, 5e3, 300, (value) => text2(value, 100)) || !mapping(body.bank_mappings ?? {}, 1e4, 1e3, uuid) || !validResolutionChoices(body.resolution_choices ?? {})) return false;
  if (body.action === "preview") return !["complete", "previous_import_id", "previous_financial_revision", "expected_report_date", "request_id"].some((key) => Object.hasOwn(body, key));
  return body.complete === true && (body.previous_import_id === null || uuid(body.previous_import_id)) && text2(body.previous_financial_revision, 256) && validReconciliationDate(body.expected_report_date) && uuid(body.request_id);
}
function sameSourceRow(first, second) {
  return object2(first) && Object.keys(first).length === Object.keys(second).length && Object.keys(second).every((key) => Object.hasOwn(first, key) && first[key] === second[key]);
}
function validDailyPreview(preview, { sourceRows, reportKind, resolutionChoices = {}, emptyReportConfirmed = false } = {}) {
  if (!object2(preview) || !Array.isArray(sourceRows) || reportKind !== "ALL" || preview.mode !== "daily" || preview.daily_report_version !== DAILY_REPORT_VERSION || preview.report_kind !== reportKind || !validReconciliationDate(preview.report_date) || !text2(preview.financial_revision, 256) || !(preview.previous_import_id === null || uuid(preview.previous_import_id)) || typeof preview.can_commit !== "boolean" || typeof preview.baseline_only !== "boolean" || preview.empty_report_confirmed !== emptyReportConfirmed || typeof emptyReportConfirmed !== "boolean" || emptyReportConfirmed && sourceRows.length !== 0) return false;
  const filtered = dailyReportSourceRows(sourceRows, reportKind);
  if (!filtered.length && !emptyReportConfirmed || !Array.isArray(preview.rows) || preview.rows.length !== filtered.length || preview.rows.some((row, index) => !sameSourceRow(row, filtered[index])) || preview.row_count !== filtered.length || preview.ignored_cheque_count !== sourceRows.length - filtered.length || !["new_count", "open_count", "changed_count", "missing_count", "auto_payment_count", "auto_payment_cents"].every((key) => count(preview[key])) || preview.new_count + preview.open_count !== preview.row_count || preview.changed_count > preview.open_count || !["exceptions", "automatic_actions", "reconciliation_items", "errors", "bank_options"].every((key) => Array.isArray(preview[key]) && preview[key].length <= 15e3) || !["PREVIOUS_REPORT", "FIRST_REPORT"].includes(preview.baseline_origin) || preview.can_commit && preview.errors.length > 0) return false;
  if (preview.bank_options.some((bank) => !object2(bank) || !uuid(bank.id) || !text2(bank.display_name, 200))) return false;
  if (new Set(preview.bank_options.map((bank) => bank.id)).size !== preview.bank_options.length) return false;
  if (JSON.stringify(preview.exceptions) !== JSON.stringify(preview.reconciliation_items)) return false;
  if (preview.errors.some((error) => !object2(error) || !count(error.line) || error.line > 5001 || !text2(error.column, 300) || !text2(error.problem, 2e3) || !text2(error.correction, 2e3))) return false;
  const keys = /* @__PURE__ */ new Set(), titleIds = /* @__PURE__ */ new Set(), banks = new Set(preview.bank_options.map((bank) => bank.id));
  let automaticCents = 0n, missing = 0;
  for (const [items, automatic] of [[preview.exceptions, false], [preview.automatic_actions, true]]) {
    for (const item of items) {
      if (!object2(item) || !validResolutionKey(item.key, filtered.length) || keys.has(item.key) || !["CENT", "MISSING", "REAPPEARED"].includes(item.kind) || !(item.line === null || Number.isSafeInteger(item.line) && item.line >= 1 && item.line <= filtered.length) || !(item.title_id === null && item.kind === "CENT" || uuid(item.title_id)) || !text2(item.branch, 300) || !text2(item.entry_number, 300) || typeof item.description !== "string" || item.description.length > 1500 || !validReconciliationDate(item.due_date) || !count(item.amount_cents) || !count(item.payment_remaining_cents) || !Array.isArray(item.allowed_actions) || item.allowed_actions.length > 3 || new Set(item.allowed_actions).size !== item.allowed_actions.length || item.allowed_actions.some((action) => !["PAID", "WRITE_OFF", "REOPEN"].includes(action)) || !(item.selected_action === null || item.allowed_actions.includes(item.selected_action)) || typeof item.requires_resolution !== "boolean" || !(item.problem === null || text2(item.problem, 2e3)) || !(item.paid_on === null || validReconciliationDate(item.paid_on)) || !(item.bank_account_id === null || uuid(item.bank_account_id)) || !(item.bank_label === null || text2(item.bank_label, 200)) || !(item.cheque_number === null || typeof item.cheque_number === "string" && item.cheque_number.length <= 150) || typeof item.is_cheque !== "boolean" || item.rule !== (item.is_cheque ? "IMPORT_DATE" : "DUE_DATE") || typeof item.cheque_number === "string" && item.cheque_number.trim() && !item.is_cheque) return false;
      if (item.title_id !== null && titleIds.has(item.title_id)) return false;
      if (item.kind === "MISSING") {
        if (item.line !== null || !uuid(item.title_id) || item.key !== `title:${item.title_id}`) return false;
        missing++;
      } else if (item.line === null) return false;
      if (item.kind === "CENT" && (item.key !== `row:${item.line}` || filtered[item.line - 1].amount_cents !== 1 || !(item.allowed_actions.length === 1 && item.allowed_actions[0] === "WRITE_OFF" || !preview.can_commit && item.allowed_actions.length === 0 && item.problem !== null))) return false;
      if (item.kind === "REAPPEARED" && item.key !== `title:${item.title_id}`) return false;
      if (item.line !== null) {
        const row = filtered[item.line - 1];
        if (item.branch !== row.branch || item.entry_number !== row.entry_number || item.due_date !== row.due_date || item.is_cheque !== isDailyCheque(row)) return false;
      }
      if (automatic) {
        if (item.kind !== "MISSING" || item.amount_cents === 1 || item.payment_remaining_cents <= 0 || item.requires_resolution || item.selected_action !== "PAID" || item.allowed_actions.length !== 1 || item.allowed_actions[0] !== "PAID" || item.problem !== null || !banks.has(item.bank_account_id) || item.bank_label === null || item.paid_on !== (item.is_cheque ? preview.report_date : item.due_date) || item.paid_on > preview.report_date) return false;
        automaticCents += BigInt(item.payment_remaining_cents);
      } else {
        const choice = resolutionChoices[item.key];
        if (item.requires_resolution !== true || item.selected_action !== (choice?.action ?? null) || item.kind === "MISSING" && (item.amount_cents === 1 ? item.allowed_actions.length !== 1 || item.allowed_actions[0] !== "WRITE_OFF" : item.allowed_actions.length !== 1 || item.allowed_actions[0] !== "PAID")) return false;
        if (preview.can_commit && (item.problem !== null || !choice || choice.action === "PAID" && (choice.paid_on !== item.paid_on || choice.amount_paid_cents !== item.payment_remaining_cents || choice.bank_account_id !== item.bank_account_id || !banks.has(item.bank_account_id) || item.paid_on > preview.report_date))) return false;
      }
      if (item.amount_cents !== 1 && typeof item.cheque_number === "string" && item.cheque_number.trim() && item.selected_action === "PAID" && item.problem === null) {
        const official = preview.bank_options.filter((bank) => bank.account_type === "BANK" && normalizePaidBankDescription(bank.display_name) === "BRADESCO F2G");
        if (official.length !== 1 || official[0].id !== item.bank_account_id) return false;
      }
      keys.add(item.key);
      if (item.title_id !== null) titleIds.add(item.title_id);
    }
  }
  if (preview.auto_payment_count !== preview.automatic_actions.length || automaticCents !== BigInt(preview.auto_payment_cents) || missing !== preview.missing_count || preview.baseline_only && missing > 0 || preview.baseline_only !== (preview.baseline_origin === "FIRST_REPORT") || preview.can_commit && Object.keys(resolutionChoices).some((key) => !keys.has(key))) return false;
  for (let index = 0; index < filtered.length; index++) if (filtered[index].amount_cents === 1 && !preview.exceptions.some((item) => item.kind === "CENT" && item.line === index + 1)) return false;
  return true;
}
function validDailyCommit(result, { sourceRows, request } = {}) {
  if (!object2(result) || !Array.isArray(sourceRows) || !object2(request) || result.mode !== "daily" || request.report_kind !== "ALL" || result.daily_report_version !== DAILY_REPORT_VERSION || result.report_kind !== request.report_kind || result.report_date !== request.expected_report_date || result.request_id !== request.request_id || result.empty_report_confirmed !== (request.empty_report_confirmed ?? false) || Object.hasOwn(request, "empty_report_confirmed") && typeof request.empty_report_confirmed !== "boolean" || !uuid(result.report_id) || !uuid(result.import_id) || typeof result.idempotent !== "boolean" || !["row_count", "new_count", "open_count", "changed_count", "paid_count", "written_off_count", "automatic_paid_count", "payment_cents"].every((key) => count(result[key]))) return false;
  const filtered = dailyReportSourceRows(sourceRows, request.report_kind);
  return (filtered.length > 0 && request.empty_report_confirmed !== true || request.empty_report_confirmed === true && sourceRows.length === 0) && result.row_count === filtered.length && result.new_count + result.open_count === result.row_count && result.changed_count <= result.open_count && result.automatic_paid_count <= result.paid_count;
}

// supabase/functions/payables-import/handler.mjs
var MAX_BODY_BYTES = 12 * 1024 * 1024;
var MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_FILE_BYTES / 3);
var UUID3 = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
var SERVICE_FAILURE = "N\xE3o foi poss\xEDvel confirmar a opera\xE7\xE3o. Atualize o hist\xF3rico antes de tentar novamente.";
var INVALID_REQUEST = "Solicita\xE7\xE3o inv\xE1lida. Selecione novamente o relat\xF3rio completo.";
var PARSE_FAILURE = "N\xE3o foi poss\xEDvel analisar o arquivo. Salve uma c\xF3pia somente com valores e confira os cabe\xE7alhos.";
var CORRECTION = "Confira o formato e os cabe\xE7alhos, salve uma c\xF3pia somente com valores e tente novamente.";
var PAYMENT_DATE_VERSION = "2026-10-27.1";
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
  "Data Excel inv\xE1lida.",
  "Hor\xE1rio inv\xE1lido. Use hh:mm ou hh:mm:ss, entre 00:00:00 e 23:59:59.",
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
  "N\xFAmero de cheque inv\xE1lido. Use texto ou n\xFAmero inteiro n\xE3o negativo, sem nota\xE7\xE3o cient\xEDfica.",
  "Formato da c\xE9lula do cheque n\xE3o suportado. No Excel, formate o n\xFAmero do cheque como Texto ou use somente zeros, como 000000.",
  "O valor pago deve ser maior que zero.",
  "A data do pagamento \xE9 futura.",
  "A data de refer\xEAncia da confer\xEAncia \xE9 inv\xE1lida.",
  "O relat\xF3rio de pagamentos cont\xE9m situa\xE7\xE3o incompat\xEDvel com pagamento confirmado.",
  "Lan\xE7amento repetido no relat\xF3rio de pagamentos.",
  "O relat\xF3rio cont\xE9m t\xEDtulos. Desmarque a declara\xE7\xE3o de posi\xE7\xE3o sem cheques pendentes.",
  "O relat\xF3rio cont\xE9m t\xEDtulos. Desmarque a declara\xE7\xE3o de relat\xF3rio sem t\xEDtulos em aberto."
]);
var safeMessage = (message) => SAFE_MESSAGES.has(message) || /^Limite de (?:150|300|1500) caracteres excedido\.$/.test(message) ? message : PARSE_FAILURE;
function officialToday(value) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
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
  if (payload.sub !== userId || typeof payload.session_id !== "string" || !UUID3.test(payload.session_id)) throw new Error("invalid_session");
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
function createPayablesGateway({ env, fetch: fetcher = globalThis.fetch, loadWorkbook, log = () => {
}, now = () => /* @__PURE__ */ new Date() }) {
  return async function handle(request) {
    let origins;
    try {
      origins = originsFrom(env("ALLOWED_ORIGINS"));
    } catch {
      return new Response(JSON.stringify({ error: SERVICE_FAILURE }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    const origin = request.headers.get("origin");
    if (!origin || !origins.has(origin)) return new Response(JSON.stringify({ error: "Origem n\xE3o autorizada." }), { status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" } });
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin"
    };
    const respond = (status, payload, extra = {}) => new Response(JSON.stringify(payload), { status, headers: { ...headers, ...extra } });
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
    if (request.method !== "POST") return respond(405, { error: "M\xE9todo n\xE3o permitido." }, { Allow: "POST, OPTIONS" });
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/i)?.[1];
    if (!token) return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
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
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5e4)]);
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
      if (code === "42501") return respond(403, { code, error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      if (code === "40001") return respond(409, { code, error: "A base mudou desde a an\xE1lise. Analise o arquivo novamente antes de concluir." });
      if (code === "23505") return respond(409, { code, error: "Este arquivo j\xE1 foi importado para esta origem. Nenhum dado foi alterado." });
      if (code === "P0016") return respond(409, { code, error: "H\xE1 lan\xE7amentos repetidos ou vers\xF5es hist\xF3ricas amb\xEDguas para a mesma filial e n\xFAmero. Confira parcelas e o hist\xF3rico. Nenhum dado foi alterado." });
      if (code === "P0019") return respond(409, { code, error: "Ative a atualiza\xE7\xE3o dos n\xFAmeros de cheque no banco de dados antes de importar esta coluna. Nenhum dado foi alterado." });
      if (code === "P0021") return respond(409, { code, error: "Ative a atualiza\xE7\xE3o de previs\xF5es e pagamentos no banco de dados antes de usar este modo. Nenhum dado foi alterado." });
      if (code === "P0042") return respond(409, { code, error: "Confira a baixa sem pagamento e os dados atuais do t\xEDtulo antes de confirmar." });
      if (code === "P0043") return respond(409, { code, error: "Confira as escolhas da concilia\xE7\xE3o e atualize o banco e a fun\xE7\xE3o de importa\xE7\xE3o quando solicitado." });
      if (code === "P0050") return respond(409, { code, activation_required: true, error: "Ative as regras de bancos e baixas de Caixa Interno no banco e na fun\xE7\xE3o payables-import antes de importar." });
      if (code === "P0059") return respond(409, { code, activation_required: true, error: "Ative o SQL 059 de atualiza\xE7\xE3o das colunas de Contas a Pagar e atualize a fun\xE7\xE3o payables-import." });
      if (code === "P0060") return result.payload?.activation_required === true ? respond(409, { code, activation_required: true, error: "Ative o SQL 060 do relat\xF3rio \xFAnico de Contas a Pagar e atualize a fun\xE7\xE3o payables-import." }) : respond(409, { code, activation_required: false, error: "Use o relat\xF3rio di\xE1rio \xFAnico completo e confira as exce\xE7\xF5es antes de concluir." });
      if (code === "P0058") return result.payload?.activation_required === true ? respond(409, { code, activation_required: true, error: "Ative a concilia\xE7\xE3o di\xE1ria de t\xEDtulos e cheques no banco e atualize a fun\xE7\xE3o payables-import." }) : respond(409, { code, activation_required: false, error: "Confira as exce\xE7\xF5es e use o relat\xF3rio completo atualizado antes de concluir a concilia\xE7\xE3o di\xE1ria." });
      if (code === "22023" || code === "23514") return respond(400, { code, error: "A importa\xE7\xE3o foi recusada. Confira as linhas, a origem completa e a classifica\xE7\xE3o de todos os planos." });
      if (result.status === 401) return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
      log("upstream_unavailable");
      return respond(503, { error: SERVICE_FAILURE });
    }
    try {
      const auth = await call("/auth/v1/user", { method: "GET" });
      if (!auth.ok) return auth.status === 401 || auth.status === 403 ? respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." }) : upstreamFailure(auth);
      if (typeof auth.payload?.id !== "string" || !UUID3.test(auth.payload.id)) throw new Error("invalid_identity");
      let sessionId;
      try {
        sessionId = verifiedSessionId(token, auth.payload.id);
      } catch {
        return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
      }
      const access = await call("/rest/v1/rpc/current_access", { data: {} });
      if (!access.ok) return upstreamFailure(access);
      if (access.payload?.profile?.id !== auth.payload.id || access.payload.profile.enabled !== true || !Array.isArray(access.payload.permissions) || !access.payload.permissions.some((permission) => permission?.resource === "contas_pagar" && permission.action === "import")) {
        return respond(403, { code: "42501", error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      }
      let body;
      try {
        body = await readBody(request);
      } catch {
        return respond(400, { error: INVALID_REQUEST });
      }
      const reconciled = body.reconciliation_version === "043";
      const daily = body.mode === "daily";
      const useExplicitPaymentDate = body.payment_date_version === PAYMENT_DATE_VERSION;
      const useBankRules = body.bank_rules_version === "050";
      const useColumnRules = body.column_rules_version === "059";
      if (daily && !validDailyRequest(body)) return respond(400, { error: INVALID_REQUEST });
      if (!daily && (Object.keys(body).some((key) => !["action", "file_name", "file_base64", "mappings", "complete", "previous_import_id", "mode", "bank_mappings", "confirm_corrections", "previous_financial_revision", "reconciliation_version", "full_report", "resolution_choices", "request_id", "payment_date_version", "bank_rules_version", "column_rules_version"].includes(key)) || !["preview", "commit"].includes(body.action) || Object.hasOwn(body, "mode") && !["forecast", "payments"].includes(body.mode) || Object.hasOwn(body, "payment_date_version") && (body.mode !== "payments" || !useExplicitPaymentDate) || Object.hasOwn(body, "bank_rules_version") && (body.mode !== "payments" || !useBankRules || !useExplicitPaymentDate || !reconciled) || Object.hasOwn(body, "column_rules_version") && (body.mode !== "payments" || !useColumnRules || !useBankRules || !useExplicitPaymentDate || !reconciled) || Object.hasOwn(body, "reconciliation_version") && !reconciled || Object.hasOwn(body, "request_id") && (typeof body.request_id !== "string" || !UUID3.test(body.request_id)) || !reconciled && ["full_report", "resolution_choices", "request_id"].some((key) => Object.hasOwn(body, key)) || reconciled && (!["forecast", "payments"].includes(body.mode) || !validResolutionChoices(body.resolution_choices ?? {}) || body.mode === "forecast" && typeof body.full_report !== "boolean" || body.mode === "payments" && Object.hasOwn(body, "full_report") && body.full_report !== false) || body.mode !== "payments" && (Object.hasOwn(body, "bank_mappings") || Object.hasOwn(body, "confirm_corrections") || !reconciled && Object.hasOwn(body, "previous_financial_revision")) || typeof body.file_name !== "string" || body.file_name.length < 1 || body.file_name.length > 250 || body.file_name !== body.file_name.trim() || /[/\\\u0000-\u001f\u007f]/.test(body.file_name))) return respond(400, { error: INVALID_REQUEST });
      const validPlanMappings = (mappings) => mappings && typeof mappings === "object" && !Array.isArray(mappings) && Object.keys(mappings).length <= MAX_ROWS && !Object.entries(mappings).some(([key, value]) => !key.trim() || key.length > 300 || typeof value !== "string" || !value.trim() || value.length > 100);
      if (Object.hasOwn(body, "mappings") && !validPlanMappings(body.mappings) || body.mode === "payments" && Object.hasOwn(body, "bank_mappings") && (!body.bank_mappings || typeof body.bank_mappings !== "object" || Array.isArray(body.bank_mappings) || Object.keys(body.bank_mappings).length > MAX_ROWS || Object.entries(body.bank_mappings).some(([key, value]) => !key.trim() || key.length > 1e3 || typeof value !== "string" || !UUID3.test(value))) || Object.hasOwn(body, "confirm_corrections") && typeof body.confirm_corrections !== "boolean" || Object.hasOwn(body, "previous_financial_revision") && body.previous_financial_revision !== null && (typeof body.previous_financial_revision !== "string" || !body.previous_financial_revision || body.previous_financial_revision !== body.previous_financial_revision.trim() || body.previous_financial_revision.length > 256)) return respond(400, { error: INVALID_REQUEST });
      if ((body.mode === "payments" || reconciled || daily) && !["read", "write"].every((action) => access.payload.permissions.some((permission) => permission?.resource === "contas_pagar" && permission.action === action)) || daily && !access.payload.permissions.some((permission) => permission?.resource === "importar_bases" && permission.action === "read")) {
        return respond(403, { code: "42501", error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      }
      if (/\.xls$/i.test(body.file_name)) return respond(400, { error: "O formato .xls antigo ainda n\xE3o \xE9 aceito. No Excel, salve uma c\xF3pia como .xlsx." });
      if (!/\.(xlsx|xlsm|csv)$/i.test(body.file_name)) return respond(400, { error: "Selecione um arquivo .xlsx, .xlsm ou .csv." });
      if (!daily && body.action === "commit" && (body.complete !== true || body.mode !== "payments" && !validPlanMappings(body.mappings) || (body.mode === "payments" || reconciled) && (typeof body.previous_financial_revision !== "string" || !body.previous_financial_revision) || reconciled && (typeof body.request_id !== "string" || !UUID3.test(body.request_id)) || !(body.previous_import_id === null || typeof body.previous_import_id === "string" && UUID3.test(body.previous_import_id)))) return respond(400, { error: INVALID_REQUEST });
      let bytes;
      try {
        bytes = decodeFile(body.file_base64);
      } catch {
        return respond(400, { error: "O arquivo est\xE1 vazio, inv\xE1lido ou excede 2 MiB. Selecione novamente uma c\xF3pia do relat\xF3rio completo." });
      }
      let parsed;
      try {
        let matrix, excel1904 = false;
        if (/\.csv$/i.test(body.file_name)) matrix = parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        else {
          const buffer = bytes.buffer;
          await validateWorkbookExpandedSize(buffer);
          if (typeof loadWorkbook !== "function") throw new Error("workbook_loader_unavailable");
          const loaded = await loadWorkbook(buffer);
          matrix = loaded.matrix;
          excel1904 = loaded.excel1904 === true;
        }
        if (!Array.isArray(matrix) || matrix.length > MAX_ROWS + 1 || matrix.some((row) => !Array.isArray(row) || row.length > 100)) {
          throw new Error("Planilha excede 5.000 linhas ou 100 colunas.");
        }
        parsed = body.mode === "payments" ? validatePayablePaidRows(matrix, { excel1904, today: officialToday(now()), useExplicitPaymentDate, allowInternalCashWriteoff: useBankRules, ...useColumnRules ? { columnRulesVersion: "059" } : {} }) : daily ? validatePayableDailyRows(matrix, { excel1904, allowEmptyReport: body.empty_report_confirmed === true }) : validatePayableRows(matrix, { excel1904 });
      } catch (error) {
        return respond(422, { code: "SOURCE_VALIDATION_FAILED", error: "Importa\xE7\xE3o bloqueada. Nenhum dado foi alterado.", errors: [{ line: 0, column: "Arquivo", problem: safeMessage(error instanceof Error ? error.message : ""), correction: CORRECTION }] });
      }
      if (parsed.errors.length) return respond(422, { code: "SOURCE_VALIDATION_FAILED", error: "Importa\xE7\xE3o bloqueada. Nenhum dado foi alterado.", errors: problemsFor(parsed.errors) });
      if (reconciled && !validResolutionChoices(body.resolution_choices ?? {}, parsed.rows.length)) return respond(400, { error: INVALID_REQUEST });
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (signal.aborted) throw new Error("request_timed_out");
      if (daily) {
        const selectedRows = dailyReportSourceRows(parsed.rows, body.report_kind);
        if (!selectedRows.length && body.empty_report_confirmed !== true) {
          return respond(422, { code: "SOURCE_VALIDATION_FAILED", error: "Importa\xE7\xE3o bloqueada. Nenhum dado foi alterado.", errors: [{
            line: 0,
            column: "Relat\xF3rio completo",
            problem: "Confirme expressamente a posi\xE7\xE3o sem t\xEDtulos em aberto para importar somente os cabe\xE7alhos.",
            correction: "Use o relat\xF3rio completo ou marque a declara\xE7\xE3o de posi\xE7\xE3o sem t\xEDtulos em aberto."
          }] });
        }
        if (!validResolutionChoices(body.resolution_choices ?? {}, selectedRows.length)) return respond(400, { error: INVALID_REQUEST });
        const capabilities = await call("/rest/v1/rpc/payables_import_capabilities", { data: {} });
        const missingSchema = !capabilities.ok && ["PGRST202", "42883", "42P01"].includes(capabilities.payload?.code);
        if (missingSchema || capabilities.ok && (capabilities.payload?.daily_reports !== true || capabilities.payload?.daily_report_version !== "060" || capabilities.payload?.unified_daily_report !== true || capabilities.payload?.column_rules_version !== "059")) {
          return upstreamFailure({ status: 409, payload: { code: "P0060", activation_required: true } });
        }
        if (!capabilities.ok) return upstreamFailure(capabilities);
        const data = {
          p_scope: "grupo-consolidado",
          p_rows: parsed.rows,
          p_report_kind: body.report_kind,
          p_mappings: body.mappings ?? {},
          p_bank_mappings: body.bank_mappings ?? {},
          p_resolution_choices: body.resolution_choices ?? {},
          p_empty_report_confirmed: body.empty_report_confirmed ?? false
        };
        const path2 = body.action === "preview" ? "preview_payables_unified_report" : "commit_payables_unified_report_from_gateway";
        const previewStartedOn = officialToday(now());
        const result = await call(`/rest/v1/rpc/${path2}`, { service: body.action === "commit", data: {
          ...data,
          ...body.action === "commit" ? {
            p_user_id: auth.payload.id,
            p_session_id: sessionId,
            p_file_name: body.file_name,
            p_file_sha256: hash,
            p_file_base64: body.file_base64,
            p_previous_import_id: body.previous_import_id,
            p_previous_financial_revision: body.previous_financial_revision,
            p_expected_report_date: body.expected_report_date,
            p_request_id: body.request_id
          } : {}
        } });
        if (!result.ok && ["PGRST202", "42883", "42P01"].includes(result.payload?.code)) return upstreamFailure({ status: 409, payload: { code: "P0060", activation_required: true } });
        if (!result.ok) return upstreamFailure(result);
        if (body.action === "preview") {
          if (!validDailyPreview(result.payload, { sourceRows: parsed.rows, reportKind: body.report_kind, resolutionChoices: body.resolution_choices ?? {}, emptyReportConfirmed: body.empty_report_confirmed ?? false }) || ![previewStartedOn, officialToday(now())].includes(result.payload.report_date)) throw new Error("invalid_daily_preview");
          return respond(200, { rows: result.payload.rows, preview: result.payload, file_sha256: hash });
        }
        if (!validDailyCommit(result.payload, { sourceRows: parsed.rows, request: body })) throw new Error("invalid_daily_commit");
        return respond(200, result.payload);
      }
      const hasCheque = parsed.rows.some((row) => Object.hasOwn(row, "cheque_number"));
      {
        const capabilities = await call("/rest/v1/rpc/payables_import_capabilities", { data: {} });
        const required = body.mode === "forecast" ? "forecast_incremental" : body.mode === "payments" ? "paid_import" : hasCheque ? "cheque_number" : null;
        if (capabilities.ok && capabilities.payload?.unified_daily_report === true) return upstreamFailure({ status: 409, payload: { code: "P0060", activation_required: false } });
        const missingSchema = !capabilities.ok && ["PGRST202", "42883"].includes(capabilities.payload?.code);
        if (useColumnRules && (missingSchema || capabilities.ok && capabilities.payload?.column_rules_version !== "059")) return upstreamFailure({ status: 409, payload: { code: "P0059", activation_required: true } });
        if (useBankRules && (missingSchema || capabilities.ok && (capabilities.payload?.paid_bank_rules_version !== "050" || capabilities.payload?.internal_cash_writeoff !== true))) {
          return upstreamFailure({ status: 409, payload: { code: "P0050" } });
        }
        if (reconciled && (missingSchema || capabilities.ok && (capabilities.payload?.reconciliation_version !== "043" || capabilities.payload?.import_reconciliation !== true))) {
          return respond(409, { code: "P0043", activation_required: true, error: "Ative a concilia\xE7\xE3o na importa\xE7\xE3o no banco e atualize a fun\xE7\xE3o payables-import antes de confirmar." });
        }
        if (required !== null && (missingSchema || capabilities.ok && capabilities.payload?.[required] !== true)) {
          const code = body.mode ? "P0021" : "P0019";
          return upstreamFailure({ status: 409, payload: { code } });
        }
        if (!capabilities.ok && !(required === null && missingSchema)) return upstreamFailure(capabilities);
        if (hasCheque && capabilities.payload?.cheque_number !== true) return upstreamFailure({ status: 409, payload: { code: "P0019" } });
      }
      if (signal.aborted) throw new Error("request_timed_out");
      if (body.action === "preview") {
        const path2 = body.mode === "payments" ? reconciled ? "preview_payables_paid_import_v2" : "preview_payables_paid_import" : body.mode === "forecast" ? reconciled ? "preview_payables_forecast_import_v2" : "preview_payables_forecast_import" : "preview_payables_import";
        const preview = await call(`/rest/v1/rpc/${path2}`, { data: {
          p_scope: "grupo-consolidado",
          p_rows: parsed.rows,
          ...body.mode === "payments" ? { p_bank_mappings: body.bank_mappings ?? {}, p_mappings: body.mappings ?? {} } : {},
          ...reconciled ? { p_resolution_choices: body.resolution_choices ?? {}, ...body.mode === "forecast" ? { p_full_report: body.full_report } : {} } : {}
        } });
        if (!preview.ok && reconciled && ["PGRST202", "42883", "42P01"].includes(preview.payload?.code)) return respond(409, { code: useBankRules ? "P0050" : "P0043", activation_required: true, error: "Atualize a estrutura de concilia\xE7\xE3o na importa\xE7\xE3o antes de analisar novamente." });
        if (!preview.ok) return upstreamFailure(preview);
        if (!preview.payload || preview.payload.row_count !== parsed.rows.length) throw new Error("invalid_preview");
        if (reconciled && !validReconciliationPreview(preview.payload, { rowCount: parsed.rows.length, mode: body.mode, fullReport: body.full_report, sourceRows: parsed.rows, resolutionChoices: body.resolution_choices ?? {}, ...useBankRules ? { bankRulesVersion: "050" } : {}, ...useColumnRules ? { columnRulesVersion: "059" } : {} })) throw new Error("invalid_preview");
        if (body.mode === "payments") {
          const cashSource = (row, index) => useBankRules && isInternalCashBank(parsed.rows[index].paid_bank) && !(useColumnRules && row.payment_bank_rule === "CHEQUE_F2G");
          if (preview.payload.mode !== "payments" || !["new_payment_count", "matched_payment_count", "correction_count", "conflict_count"].every((key) => Number.isSafeInteger(preview.payload[key]) && preview.payload[key] >= 0) || typeof preview.payload.financial_revision !== "string" || !preview.payload.financial_revision || preview.payload.financial_revision !== preview.payload.financial_revision.trim() || preview.payload.financial_revision.length > 256 || typeof preview.payload.can_commit !== "boolean" || !Array.isArray(preview.payload.rows) || !Array.isArray(preview.payload.errors) || preview.payload.rows.length !== parsed.rows.length || preview.payload.rows.some((row, index) => !row || typeof row !== "object" || Array.isArray(row) || row.line !== index + 1 || !["NEW_PAYMENT", "MATCHED", "CORRECTION", "UNKNOWN_TITLE", "CONFLICT", "UNCLASSIFIED_PLAN", "UNMAPPED_BANK", ...reconciled ? ["WRITE_OFF", "WRITE_OFF_PENDING", "ADMIN_WRITEOFF"] : []].includes(row.outcome) || reconciled && (row.amount_paid_cents === 1 || cashSource(row, index)) && !["WRITE_OFF", "WRITE_OFF_PENDING", "UNKNOWN_TITLE", "CONFLICT"].includes(row.outcome) || reconciled && row.outcome === "WRITE_OFF" && row.amount_paid_cents !== 1 && !cashSource(row, index) || cashSource(row, index) && (row.paid_on !== null || row.bank_account_id !== null || Object.hasOwn(row, "payment_ids") && (!Array.isArray(row.payment_ids) || row.payment_ids.length !== 0)) || reconciled && preview.payload.can_commit && !["NEW_PAYMENT", "MATCHED", "CORRECTION", "WRITE_OFF"].includes(row.outcome) || !(row.title_id === null || typeof row.title_id === "string" && UUID3.test(row.title_id)) || !(row.forecast_due_date === null || typeof row.forecast_due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.forecast_due_date)) || typeof row.bank_mapping_key !== "string" || !row.bank_mapping_key || row.bank_mapping_key.length > 1e3 || ["branch", "entry_number", "amount_paid_cents", "paid_bank"].some((key) => row[key] !== parsed.rows[index][key]) || row.paid_on !== parsed.rows[index].paid_on && !(useColumnRules && cashSource(row, index) && row.paid_on === null)) || !Array.isArray(preview.payload.unmapped_banks) || !Array.isArray(preview.payload.bank_options) || !Array.isArray(preview.payload.unclassified_plans)) throw new Error("invalid_preview");
        } else if (!Number.isSafeInteger(preview.payload.new_count) || !Number.isSafeInteger(preview.payload.open_count) || !Number.isSafeInteger(preview.payload.settled_count) || body.mode === "forecast" && (preview.payload.mode !== "forecast" || preview.payload.settled_count !== 0)) throw new Error("invalid_preview");
        return respond(200, {
          rows: body.mode === "payments" ? preview.payload.rows : parsed.rows,
          preview: preview.payload,
          file_sha256: hash,
          ...useExplicitPaymentDate ? { payment_date_version: PAYMENT_DATE_VERSION } : {},
          ...useBankRules ? { bank_rules_version: "050" } : {}
        });
      }
      const path = body.mode === "payments" ? reconciled ? "commit_payables_paid_import_v2_from_gateway" : "commit_payables_paid_import_from_gateway" : body.mode === "forecast" ? reconciled ? "commit_payables_forecast_import_v2_from_gateway" : "commit_payables_forecast_import_from_gateway" : "commit_payables_import_from_gateway";
      const committed = await call(`/rest/v1/rpc/${path}`, { service: true, data: {
        p_user_id: auth.payload.id,
        p_session_id: sessionId,
        p_scope: "grupo-consolidado",
        p_file_name: body.file_name,
        p_file_sha256: hash,
        p_file_base64: body.file_base64,
        p_rows: parsed.rows,
        p_mappings: body.mappings ?? {},
        p_previous_import_id: body.previous_import_id,
        ...body.mode === "payments" ? { p_bank_mappings: body.bank_mappings ?? {}, p_confirm_corrections: body.confirm_corrections ?? false, p_previous_financial_revision: body.previous_financial_revision ?? null } : body.mode === "forecast" ? {} : { p_complete: true },
        ...reconciled ? {
          p_resolution_choices: body.resolution_choices ?? {},
          p_request_id: body.request_id,
          ...body.mode === "forecast" ? { p_full_report: body.full_report, p_previous_financial_revision: body.previous_financial_revision } : {}
        } : {}
      } });
      if (!committed.ok && reconciled && ["PGRST202", "42883", "42P01"].includes(committed.payload?.code)) return respond(409, { code: useBankRules ? "P0050" : "P0043", activation_required: true, error: "Atualize a estrutura de concilia\xE7\xE3o na importa\xE7\xE3o antes de confirmar novamente." });
      if (!committed.ok) return upstreamFailure(committed);
      if (!committed.payload || committed.payload.row_count !== parsed.rows.length || typeof committed.payload.import_id !== "string" || !UUID3.test(committed.payload.import_id) || reconciled && (committed.payload.reconciliation_version !== "043" || committed.payload.request_id !== body.request_id) || useColumnRules && committed.payload.idempotent !== true && committed.payload.column_rules_version !== "059" || body.mode && (committed.payload.mode !== body.mode || committed.payload.settled_count !== 0)) throw new Error("invalid_commit_response");
      if (useExplicitPaymentDate && body.confirm_corrections === true && committed.payload.idempotent === true) {
        const eligible = parsed.rows.filter((row) => row.amount_paid_cents !== 1 && !(useBankRules && isInternalCashBank(row.paid_bank) && !(useColumnRules && row.paid_on !== null)));
        const expected = new Map(eligible.map((row) => [JSON.stringify([row.branch, row.entry_number]), row.paid_on]));
        const mandatory = useColumnRules ? new Set(eligible.filter((row) => !isInternalCashBank(row.paid_bank) || typeof row.cheque_number === "string" && row.cheque_number.trim()).map((row) => JSON.stringify([row.branch, row.entry_number]))) : new Set(expected.keys());
        const expectedCount = useColumnRules ? committed.payload.row_count - committed.payload.writeoff_count : expected.size;
        if (!Number.isSafeInteger(expectedCount) || expectedCount < mandatory.size || expectedCount > expected.size) throw new Error("payment_date_history_count_invalid");
        const recorded = /* @__PURE__ */ new Map();
        for (let offset = 0; offset <= expectedCount; offset += 500) {
          const query = new URLSearchParams({ select: "source_row", import_id: "eq." + committed.payload.import_id, order: "title_id.asc", limit: "500", offset: String(offset) });
          const history = await call("/rest/v1/payable_paid_import_rows?" + query, { method: "GET" });
          if (!history.ok || !Array.isArray(history.payload) || history.payload.length > 500 || recorded.size + history.payload.length > expectedCount) throw new Error("payment_date_history_unavailable");
          for (const item of history.payload) {
            const row = item?.source_row;
            if (!row || typeof row !== "object" || Array.isArray(row) || ["branch", "entry_number"].some((key2) => typeof row[key2] !== "string" || !row[key2] || row[key2].length > 150 || row[key2] !== row[key2].trim().replace(/\s+/g, " ")) || typeof row.paid_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.paid_on) || Object.hasOwn(row, "line") && (!Number.isSafeInteger(row.line) || row.line < 1 || row.line > MAX_ROWS)) throw new Error("payment_date_history_invalid");
            parseCivilDate(row.paid_on);
            const key = JSON.stringify([row.branch, row.entry_number]);
            if (!expected.has(key) || recorded.has(key)) throw new Error("payment_date_history_incomplete");
            recorded.set(key, row.paid_on);
          }
          if (history.payload.length < 500) break;
        }
        if (recorded.size !== expectedCount || [...mandatory].some((key) => !recorded.has(key))) throw new Error("payment_date_history_incomplete");
        if ([...recorded].some(([key, date]) => expected.get(key) !== date)) {
          return respond(409, {
            code: "PAYMENT_DATE_REVIEW_REQUIRED",
            payment_date_version: PAYMENT_DATE_VERSION,
            error: "Este arquivo j\xE1 possui uma importa\xE7\xE3o registrada. As datas n\xE3o foram corrigidas por este envio. Confira o hist\xF3rico dos pagamentos antes de continuar."
          });
        }
      }
      return respond(200, { ...committed.payload, ...useExplicitPaymentDate ? { payment_date_version: PAYMENT_DATE_VERSION } : {}, ...useBankRules ? { bank_rules_version: "050" } : {} });
    } catch {
      log("request_unavailable");
      return respond(503, { error: SERVICE_FAILURE });
    }
  };
}

// supabase/functions/payables-import/index.ts
Deno.serve(createPayablesGateway({
  env: (name) => Deno.env.get(name),
  // The handler validates actual ZIP expansion before calling this adapter.
  loadWorkbook: async (buffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const populated = workbook.worksheets.filter((sheet2) => sheet2.actualRowCount > 0);
    if (populated.length !== 1) throw new Error("A c\xF3pia para importa\xE7\xE3o deve conter uma \xFAnica aba com dados.");
    const sheet = populated[0];
    if (sheet.rowCount > 5001 || sheet.columnCount > 100) throw new Error("Planilha excede 5.000 linhas ou 100 colunas.");
    const chequeColumns = [];
    sheet.getRow(1).eachCell((cell, column) => {
      if (isChequeNumberHeader(cell.value)) chequeColumns.push(column);
    });
    const matrix = [];
    for (let index = 1; index <= sheet.rowCount; index++) {
      const source = sheet.getRow(index), values = source.values.slice(1);
      if (index > 1) for (const column of chequeColumns) {
        const cell = source.getCell(column);
        values[column - 1] = readPayableChequeCell(cell.value, cell.numFmt);
      }
      matrix.push(values);
    }
    return { matrix, excel1904: Boolean(workbook.properties.date1904) };
  },
  log: (event) => console.warn(`payables-import:${event}`)
}));
