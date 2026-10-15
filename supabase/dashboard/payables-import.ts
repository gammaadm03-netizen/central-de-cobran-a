// supabase/functions/payables-import/index.ts
import ExcelJS from "npm:exceljs@4.4.0";

// src/lib/payables-parser.mjs
var MAX_FILE_BYTES = 2 * 1024 * 1024;
var MAX_ROWS = 5e3;
var REQUIRED = ["entry_number", "description", "due_date", "amount_cents", "plan", "branch"];
var COLUMN_LABELS = { entry_number: "N\xBA lan\xE7amento", description: "Hist\xF3rico / Favorecido", due_date: "Vencimento", amount_cents: "Valor", plan: "Plano de Contas", branch: "Filial", bank_account: "Banco / Conta", issued_on: "Emiss\xE3o", source_status: "Status / Situa\xE7\xE3o" };
var normalize = (value) => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
var ALIASES = {
  entry_number: ["LANCAMENTO", "NLANCAMENTO", "NOLANCAMENTO", "NUMEROLANCAMENTO", "NUMERODOLANCAMENTO", "NUMEROLANC", "NROLANCAMENTO"],
  description: ["HISTORICO", "DESCRICAO", "HISTORICOFAVORECIDO", "FAVORECIDO"],
  due_date: ["VENCIMENTO", "DATAVENCIMENTO", "DTVENCIMENTO"],
  amount_cents: ["VALOR", "VALORTITULO", "VALORORIGINAL"],
  plan: ["PLANODECONTAS", "PLANOCONTAS"],
  branch: ["FILIAL", "CODFILIAL"],
  bank_account: ["BANCO", "CONTA", "BANCOCONTA"],
  issued_on: ["EMISSAO", "DATAEMISSAO", "DTEMISSAO"],
  source_status: ["STATUS", "SITUACAO"]
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
  const text = String(value ?? "").trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
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
  let text = String(value ?? "").trim().replace(/^R\$\s*/, "");
  if (!text) throw new Error("Valor obrigat\xF3rio.");
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text)) throw new Error("Use valor brasileiro, por exemplo 1.234,56, com at\xE9 duas casas decimais.");
  text = text.replaceAll(".", "");
  const [integer, decimal = ""] = text.split(",");
  const cents = BigInt(integer) * 100n + BigInt(decimal.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Valor excede o limite seguro.");
  return Number(cents);
}
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  if (text.includes("\0")) throw new Error("CSV cont\xE9m bytes inv\xE1lidos. Salve uma c\xF3pia em UTF-8.");
  const sample = text.split(/\r?\n/, 1)[0];
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
    if (rows.length > MAX_ROWS + 1) throw new Error("A base excede o limite de 5.000 linhas.");
  }
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inQuote) {
      if (character === '"') {
        if (text[index + 1] === '"') {
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
      if (character === "\r" && text[index + 1] === "\n") index++;
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
function validatePayableRows(matrix, { excel1904 = false } = {}) {
  const errors = [], rows = [];
  if (!matrix.length) return { rows, errors: [{ line: 1, column: "Arquivo", problem: "Arquivo vazio.", correction: "Exporte o relat\xF3rio completo com os cabe\xE7alhos." }] };
  const columns = /* @__PURE__ */ new Map();
  matrix[0].forEach((value, index) => {
    let key;
    try {
      key = headerMap.get(normalize(scalar(value)));
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
        else if (key === "due_date") row[key] = parseCivilDate(value, excel1904);
        else if (key === "issued_on") row[key] = String(value).trim() ? parseCivilDate(value, excel1904) : null;
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
    const identity = JSON.stringify([row.branch, row.entry_number, row.due_date, row.amount_cents]);
    if (errors.length === before && keys.has(identity)) errors.push({ line: index + 1, column: "N\xBA lan\xE7amento", problem: "Chave de t\xEDtulo duplicada na mesma base.", correction: "Confira filial, lan\xE7amento, vencimento e valor. N\xE3o remova duplicados sem validar a origem." });
    if (errors.length === before) {
      total += row.amount_cents;
      if (!Number.isSafeInteger(total)) errors.push({ line: index + 1, column: "Valor", problem: "Total do relat\xF3rio excede o limite de precis\xE3o.", correction: "Confira valores e origem da base antes de importar." });
      else {
        keys.add(identity);
        rows.push(row);
      }
    }
    if (errors.length >= 100) break;
  }
  if (!rows.length && !errors.length) errors.push({ line: 2, column: "Arquivo", problem: "N\xE3o h\xE1 t\xEDtulos no relat\xF3rio.", correction: "Selecione um relat\xF3rio completo com lan\xE7amentos; base vazia n\xE3o pode baixar t\xEDtulos." });
  return { rows: errors.length ? [] : rows, errors };
}

// supabase/functions/payables-import/handler.mjs
var MAX_BODY_BYTES = 3 * 1024 * 1024;
var MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_FILE_BYTES / 3);
var UUID = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
var SERVICE_FAILURE = "N\xE3o foi poss\xEDvel confirmar a opera\xE7\xE3o. Atualize o hist\xF3rico antes de tentar novamente.";
var INVALID_REQUEST = "Solicita\xE7\xE3o inv\xE1lida. Selecione novamente o relat\xF3rio completo.";
var PARSE_FAILURE = "N\xE3o foi poss\xEDvel analisar o arquivo. Salve uma c\xF3pia somente com valores e confira os cabe\xE7alhos.";
var CORRECTION = "Confira o formato e os cabe\xE7alhos, salve uma c\xF3pia somente com valores e tente novamente.";
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
  "Planilha excede 5.000 linhas ou 100 colunas."
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
  if (payload.sub !== userId || typeof payload.session_id !== "string" || !UUID.test(payload.session_id)) throw new Error("invalid_session");
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
} }) {
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
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(1e4)]);
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
      if (code === "22023" || code === "23514") return respond(400, { code, error: "A importa\xE7\xE3o foi recusada. Confira as linhas, a origem completa e a classifica\xE7\xE3o de todos os planos." });
      if (result.status === 401) return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
      log("upstream_unavailable");
      return respond(503, { error: SERVICE_FAILURE });
    }
    try {
      const auth = await call("/auth/v1/user", { method: "GET" });
      if (!auth.ok) return auth.status === 401 || auth.status === 403 ? respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." }) : upstreamFailure(auth);
      if (typeof auth.payload?.id !== "string" || !UUID.test(auth.payload.id)) throw new Error("invalid_identity");
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
      if (Object.keys(body).some((key) => !["action", "file_name", "file_base64", "mappings", "complete", "previous_import_id"].includes(key)) || !["preview", "commit"].includes(body.action) || typeof body.file_name !== "string" || body.file_name.length < 1 || body.file_name.length > 250 || body.file_name !== body.file_name.trim() || /[/\\\u0000-\u001f\u007f]/.test(body.file_name)) return respond(400, { error: INVALID_REQUEST });
      if (/\.xls$/i.test(body.file_name)) return respond(400, { error: "O formato .xls antigo ainda n\xE3o \xE9 aceito. No Excel, salve uma c\xF3pia como .xlsx." });
      if (!/\.(xlsx|xlsm|csv)$/i.test(body.file_name)) return respond(400, { error: "Selecione um arquivo .xlsx, .xlsm ou .csv." });
      if (body.action === "commit" && (body.complete !== true || !body.mappings || typeof body.mappings !== "object" || Array.isArray(body.mappings) || Object.keys(body.mappings).length > MAX_ROWS || Object.entries(body.mappings).some(([key, value]) => !key.trim() || key.length > 300 || typeof value !== "string" || !value.trim() || value.length > 100) || !(body.previous_import_id === null || typeof body.previous_import_id === "string" && UUID.test(body.previous_import_id)))) return respond(400, { error: INVALID_REQUEST });
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
        parsed = validatePayableRows(matrix, { excel1904 });
      } catch (error) {
        return respond(422, { error: "Importa\xE7\xE3o bloqueada. Nenhum dado foi alterado.", errors: [{ line: 0, column: "Arquivo", problem: safeMessage(error instanceof Error ? error.message : ""), correction: CORRECTION }] });
      }
      if (parsed.errors.length) return respond(422, { error: "Importa\xE7\xE3o bloqueada. Nenhum dado foi alterado.", errors: problemsFor(parsed.errors) });
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (signal.aborted) throw new Error("request_timed_out");
      if (body.action === "preview") {
        const preview = await call("/rest/v1/rpc/preview_payables_import", { data: { p_scope: "grupo-consolidado", p_rows: parsed.rows } });
        if (!preview.ok) return upstreamFailure(preview);
        if (!preview.payload || preview.payload.row_count !== parsed.rows.length || !Number.isSafeInteger(preview.payload.new_count) || !Number.isSafeInteger(preview.payload.open_count) || !Number.isSafeInteger(preview.payload.settled_count)) throw new Error("invalid_preview");
        return respond(200, { rows: parsed.rows, preview: preview.payload, file_sha256: hash });
      }
      const committed = await call("/rest/v1/rpc/commit_payables_import_from_gateway", { service: true, data: {
        p_user_id: auth.payload.id,
        p_session_id: sessionId,
        p_scope: "grupo-consolidado",
        p_file_name: body.file_name,
        p_file_sha256: hash,
        p_file_base64: body.file_base64,
        p_rows: parsed.rows,
        p_mappings: body.mappings,
        p_complete: true,
        p_previous_import_id: body.previous_import_id
      } });
      if (!committed.ok) return upstreamFailure(committed);
      if (!committed.payload || committed.payload.row_count !== parsed.rows.length || typeof committed.payload.import_id !== "string" || !UUID.test(committed.payload.import_id)) throw new Error("invalid_commit_response");
      return respond(200, committed.payload);
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
    const matrix = [];
    for (let index = 1; index <= sheet.rowCount; index++) matrix.push(sheet.getRow(index).values.slice(1));
    return { matrix, excel1904: Boolean(workbook.properties.date1904) };
  },
  log: (event) => console.warn(`payables-import:${event}`)
}));
