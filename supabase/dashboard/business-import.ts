// supabase/functions/business-import/index.ts
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
var headerMap = new Map(Object.entries(ALIASES).flatMap(([key, aliases3]) => aliases3.map((alias) => [alias, key])));
function parseCivilDate(value, excel1904 = false) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("Data inv\xE1lida.");
    if (value.getUTCHours() || value.getUTCMinutes() || value.getUTCSeconds() || value.getUTCMilliseconds()) throw new Error("A data cont\xE9m hor\xE1rio. Informe somente a data civil.");
    return civil(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > 2958465 || !excel1904 && value === 60) throw new Error("Data Excel inv\xE1lida ou cont\xE9m hor\xE1rio.");
    const epoch = excel1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const date3 = new Date(epoch + (value - (!excel1904 && value > 60 ? 1 : 0)) * 864e5);
    return civil(date3.getUTCFullYear(), date3.getUTCMonth() + 1, date3.getUTCDate());
  }
  const text3 = String(value ?? "").trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text3);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text3);
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
    const decimal3 = String(value);
    if (!/^\d+(?:\.\d{1,2})?$/.test(decimal3)) throw new Error("O valor deve ter no m\xE1ximo duas casas decimais, sem arredondamento.");
    const [whole, fraction = ""] = decimal3.split(".");
    const cents2 = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (cents2 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Valor excede o limite seguro.");
    return Number(cents2);
  }
  let text3 = String(value ?? "").trim().replace(/^R\$\s*/, "");
  if (!text3) throw new Error("Valor obrigat\xF3rio.");
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text3)) throw new Error("Use valor brasileiro, por exemplo 1.234,56, com at\xE9 duas casas decimais.");
  text3 = text3.replaceAll(".", "");
  const [integer, decimal2 = ""] = text3.split(",");
  const cents = BigInt(integer) * 100n + BigInt(decimal2.padEnd(2, "0"));
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

// src/lib/commercial-parser.mjs
var MAX = Number.MAX_SAFE_INTEGER;
var norm = (value) => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
var aliases = {
  code: ["C\xD3DIGO", "CODIGO", "COD PRODUTO", "COD. PRODUTO"],
  product: ["PRODUTO", "DESCRI\xC7\xC3O DO PRODUTO", "DESCRICAO DO PRODUTO", "DESCRI\xC7\xC3O", "DESCRICAO"],
  quantity: ["QUANTIDADE", "QTD"],
  sale_cents: ["VENDA TOTAL", "FATURAMENTO", "VALOR VENDA", "VALOR TOTAL", "TOTAL VENDA"],
  freight_cents: ["FRETE TOTAL", "FRETE"],
  issued_on: ["EMISS\xC3O", "EMISSAO", "DATA NOTA", "DATA VENDA"],
  client: ["CLIENTE", "ENTIDADE"],
  employee: ["FUNCION\xC1RIO COMISSIONADO", "FUNCIONARIO COMISSIONADO", "VENDEDOR", "FUNCION\xC1RIO", "FUNCIONARIO"],
  invoice: ["NOTA FISCAL", "N\xDAMERO NF", "NUMERO NF", "NFE", "NF"],
  cost_center: ["CENTRO DE CUSTO", "SETOR"],
  branch: ["FILIAL"],
  tax_cents: ["IMPOSTO TOTAL", "IMPOSTOS", "IMPOSTO"],
  cost_cents: ["CMV TOTAL", "CMV", "CUSTO TOTAL"],
  commission_cents: ["COMISS\xC3O TOTAL", "COMISSAO TOTAL", "COMISS\xC3O", "COMISSAO"],
  margin_cents: ["MARGEM L\xCDQUIDA FINAL R$", "MARGEM LIQUIDA FINAL R$", "MARGEM FINAL R$", "MARGEM L\xCDQUIDA FINAL", "MARGEM LIQUIDA FINAL", "MARGEM FINAL"]
};
var headers = new Map(Object.entries(aliases).flatMap(([key, values]) => values.map((value) => [norm(value), key])));
function scalar(value) {
  if (value == null) return "";
  if (typeof value === "object" && !(value instanceof Date)) {
    if ("formula" in value || "sharedFormula" in value) throw new Error("F\xF3rmula n\xE3o permitida. Salve uma c\xF3pia apenas com valores.");
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text ?? "").join("");
    if ("text" in value && "hyperlink" in value) return value.text;
    throw new Error("C\xE9lula n\xE3o suportada. Salve uma c\xF3pia somente com valores.");
  }
  if (typeof value === "string" && /^\s*[=+@]/.test(value)) throw new Error("Conte\xFAdo interpret\xE1vel como f\xF3rmula. Salve somente valores.");
  return value;
}
function text(value, required = false) {
  const result = String(scalar(value)).trim();
  if (required && !result) throw new Error("Campo obrigat\xF3rio vazio.");
  if (result.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) throw new Error("Texto inv\xE1lido ou maior que 500 caracteres.");
  return result;
}
function money(value) {
  value = scalar(value);
  if (value === "") return null;
  if (typeof value === "number") return value < 0 ? -parseMoneyCents(-value) : parseMoneyCents(value);
  const raw = String(value).trim(), negative = /^-/.test(raw) || /^\(.*\)$/.test(raw);
  const unsigned = raw.replace(/^-\s*/, "").replace(/^\((.*)\)$/, "$1").trim();
  return (negative ? -1 : 1) * parseMoneyCents(unsigned);
}
function date(value, excel1904) {
  value = scalar(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) return parseCivilDate(new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())), excel1904);
  if (typeof value === "number") return parseCivilDate(Math.floor(value), excel1904);
  const timestamp = /^(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(value));
  if (timestamp && (+timestamp[2] > 23 || +timestamp[3] > 59 || +(timestamp[4] ?? 0) > 59)) throw new Error("Hor\xE1rio inv\xE1lido.");
  return parseCivilDate(timestamp?.[1] ?? value, excel1904);
}
function validateCommercialRows(matrix, { excel1904 = false } = {}) {
  const errors = [], rows = [];
  const issue = (line, column, problem) => errors.push({ line, column, problem, correction: "Confira o cabe\xE7alho e os valores da linha; salve uma c\xF3pia somente com valores e analise novamente." });
  if (!Array.isArray(matrix) || matrix.length < 2 || matrix.length > 5001) {
    issue(1, "Arquivo", "Informe de 1 a 5.000 itens de fechamento.");
    return { rows, errors };
  }
  const mapped = /* @__PURE__ */ new Map();
  for (const [index, value] of (matrix[0] ?? []).entries()) {
    try {
      const header = norm(scalar(value));
      const key = headers.get(header);
      if (key && mapped.has(key)) issue(1, String(value), "Coluna duplicada ou amb\xEDgua.");
      else if (key) mapped.set(key, index);
    } catch (error) {
      issue(1, "Cabe\xE7alho", error.message);
    }
  }
  for (const key of ["product", "sale_cents", "issued_on", "client", "branch"]) if (!mapped.has(key)) issue(1, aliases[key][0], "Coluna obrigat\xF3ria ausente.");
  if (errors.length) return { rows, errors };
  for (let index = 1; index < matrix.length; index++) {
    const source = matrix[index];
    if (!Array.isArray(source) || source.length > 100) {
      issue(index + 1, "Linha", "A linha excede 100 colunas.");
      continue;
    }
    if (source.every((value) => value == null || value === "")) continue;
    try {
      source.forEach(scalar);
      if (source.slice(matrix[0].length).some((value) => value != null && value !== "")) throw new Error("H\xE1 valores fora das colunas do cabe\xE7alho.");
      const get = (key) => mapped.has(key) ? source[mapped.get(key)] : "";
      const row = { line_number: index + 1 };
      for (const key of ["code", "product", "client", "employee", "invoice", "cost_center", "branch"]) row[key] = text(get(key), ["product", "client", "branch"].includes(key));
      row.issued_on = date(get("issued_on"), excel1904);
      for (const key of ["sale_cents", "freight_cents", "tax_cents", "cost_cents", "commission_cents", "margin_cents"]) row[key] = money(get(key));
      if (row.sale_cents === null) throw new Error("Valor da venda obrigat\xF3rio.");
      const quantity = text(get("quantity"));
      row.quantity = quantity === "" ? null : Number(quantity.replace(",", "."));
      if (row.quantity !== null && (!Number.isFinite(row.quantity) || Math.abs(row.quantity) > 1e9 || !/^-?\d+(?:[.,]\d{1,6})?$/.test(quantity))) throw new Error("Quantidade inv\xE1lida; use no m\xE1ximo seis casas decimais.");
      row.margin_source = row.margin_cents !== null ? "PROVIDED" : ["freight_cents", "tax_cents", "cost_cents", "commission_cents"].every((key) => row[key] !== null) ? "CALCULATED" : "UNAVAILABLE";
      if (row.margin_source === "CALCULATED") {
        const derived = BigInt(row.sale_cents) - BigInt(row.freight_cents) - BigInt(row.tax_cents) - BigInt(row.cost_cents) - BigInt(row.commission_cents);
        if (derived > BigInt(MAX) || derived < -BigInt(MAX)) throw new Error("Valor excede o limite seguro.");
        row.margin_cents = Number(derived);
      }
      if (row.margin_cents !== null && !Number.isSafeInteger(row.margin_cents)) throw new Error("Valor excede o limite seguro.");
      rows.push(row);
    } catch (error) {
      issue(index + 1, "Item de fechamento", error.message);
    }
  }
  if (!rows.length && !errors.length) issue(2, "Arquivo", "N\xE3o h\xE1 itens no relat\xF3rio.");
  for (const key of ["sale_cents", "freight_cents", "tax_cents", "cost_cents", "commission_cents", "margin_cents"]) {
    if (rows.reduce((sum, row) => sum + BigInt(Math.abs(row[key] ?? 0)), 0n) > BigInt(MAX)) issue(0, aliases[key][0], "Total do relat\xF3rio excede o limite de precis\xE3o.");
  }
  return { rows, errors };
}

// src/lib/hr-parser.mjs
var normalize = (value) => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
var LABELS = { branch: "Filial", employee: "Funcion\xE1rio", sector: "Setor", admitted_on: "Admiss\xE3o", birthday_on: "Anivers\xE1rio", salary_base_cents: "Sal\xE1rio Folha / Base, sem descontos", payroll_salary_cents: "Sal\xE1rio recebido, com descontos", transport_cents: "VT TOTAL", advance_cents: "Adiantamento", cost_allowance_cents: "Ajuda de Custo", total_cents: "Total informado na origem", count_label: "Contagem" };
var HEADERS = { FILIAL: "branch", FUNCIONARIO: "employee", SETOR: "sector", ADMISSAO: "admitted_on", ANIVERSARIO: "birthday_on", VTTOTAL: "transport_cents", VT: "transport_cents", ADIANTAMENTO: "advance_cents", AJUDADECUSTO: "cost_allowance_cents", AJUDACUSTO: "cost_allowance_cents", TOTAL: "total_cents", CONTAGEM: "count_label", SALARIOBASE: "salary_base_cents", SALARIODAFOLHA: "salary_base_cents", SALARIOFOLHA: "salary_base_cents", SALARIORECEBIDO: "payroll_salary_cents", SALARIOLIQUIDO: "payroll_salary_cents" };
var MONEY = ["salary_base_cents", "payroll_salary_cents", "transport_cents", "advance_cents", "cost_allowance_cents", "total_cents"];
var BLANK_IS_ZERO = /* @__PURE__ */ new Set(["transport_cents", "advance_cents", "cost_allowance_cents"]);
var blank = (value) => value === null || value === void 0 || typeof value === "string" && !value.trim();
function scalar2(value) {
  if (blank(value)) return "";
  if (typeof value === "object" && !(value instanceof Date)) {
    if ("formula" in value || "sharedFormula" in value) throw new Error("F\xF3rmula n\xE3o permitida. Salve uma c\xF3pia somente com valores.");
    if (Array.isArray(value.richText)) return scalar2(value.richText.map((part) => part.text).join(""));
    if ("text" in value && "hyperlink" in value) return scalar2(value.text);
    throw new Error("C\xE9lula n\xE3o suportada. Use texto, data ou n\xFAmero.");
  }
  if (!["string", "number"].includes(typeof value) && !(value instanceof Date)) throw new Error("Tipo de c\xE9lula inv\xE1lido.");
  if (typeof value === "string" && (/^\s*[=+@]/.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) throw new Error("Conte\xFAdo inv\xE1lido ou interpret\xE1vel como f\xF3rmula. Salve somente valores.");
  return value;
}
function financialScalar(value) {
  if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
    if (typeof value.result !== "number" || !Number.isFinite(value.result)) throw new Error("A f\xF3rmula n\xE3o tem resultado num\xE9rico salvo. Recalcule e salve a planilha no Excel antes de importar.");
    const scaled = value.result * 100, cents = Math.round(scaled);
    if (!Number.isSafeInteger(cents) || Math.abs(scaled - cents) > 1e-6) throw new Error("O resultado salvo da f\xF3rmula deve ter at\xE9 duas casas decimais e respeitar o limite de precis\xE3o.");
    const exact = BigInt(cents), absolute = exact < 0n ? -exact : exact;
    return `${exact < 0n ? "-" : ""}${absolute / 100n},${String(absolute % 100n).padStart(2, "0")}`;
  }
  return scalar2(value);
}
function date2(value, excel1904) {
  if (blank(value)) return null;
  return parseCivilDate(value, excel1904);
}
function money2(value, key) {
  if (blank(value)) return BLANK_IS_ZERO.has(key) ? 0 : null;
  if (typeof value === "string" && /^(?:R\$\s*)?[-–—]$/.test(value.trim())) return 0;
  let sign = 1, source = value;
  if (typeof value === "number" && value < 0) {
    sign = -1;
    source = -value;
  } else if (typeof value === "string" && /^\s*(?:-\s*R\$|R\$\s*-|-)/.test(value)) {
    sign = -1;
    source = value.trim().replace(/^(?:-\s*R\$\s*|R\$\s*-\s*|-\s*)/, "");
  }
  if (key === "salary_base_cents" && sign < 0) throw new Error("Sal\xE1rio base n\xE3o pode ser negativo.");
  return sign * parseMoneyCents(source);
}
function validateHrRows(matrix, { excel1904 = false } = {}) {
  const errors = [], rows = [];
  let totals = null;
  const problem = (line, column, message) => errors.push({ line, column, problem: message, correction: "Corrija a c\xE9lula no arquivo original e selecione uma nova c\xF3pia." });
  if (!Array.isArray(matrix) || !matrix.length) return { rows, errors: [{ line: 1, column: "Arquivo", problem: "Arquivo vazio.", correction: "Exporte a base de RH/DP com seus cabe\xE7alhos." }] };
  const candidates = [];
  for (let line = 0; line < Math.min(matrix.length, 20); line++) {
    if (!Array.isArray(matrix[line])) continue;
    let head2;
    try {
      head2 = matrix[line].map((value) => normalize(scalar2(value)));
    } catch {
      continue;
    }
    if (head2.includes("FILIAL") && head2.includes("FUNCIONARIO") && head2.includes("SETOR")) candidates.push({ line, head: head2 });
  }
  if (!candidates.length) return { rows, errors: [{ line: 1, column: "Cabe\xE7alho", problem: "N\xE3o encontrei FILIAL, SETOR e FUNCION\xC1RIO na mesma linha.", correction: "Inclua os tr\xEAs cabe\xE7alhos. Use Sal\xE1rio Folha (ou Base) e Sal\xE1rio recebido, ou dois SAL\xC1RIO na ordem sem descontos e recebido." }] };
  const { line: headerLine, head } = candidates[0];
  if (head.length > 100) problem(headerLine + 1, "Cabe\xE7alho", "A base excede 100 colunas.");
  const columns = /* @__PURE__ */ new Map(), unnamedSalaries = [];
  head.forEach((header, index) => {
    if (header === "SALARIO") {
      unnamedSalaries.push(index);
      return;
    }
    const key = HEADERS[header];
    if (key && columns.has(key)) problem(headerLine + 1, LABELS[key], "Coluna duplicada ou amb\xEDgua.");
    else if (key) columns.set(key, index);
  });
  const remainingSalaries = ["salary_base_cents", "payroll_salary_cents"].filter((key) => !columns.has(key));
  if (unnamedSalaries.length > remainingSalaries.length) problem(headerLine + 1, "Sal\xE1rio", "H\xE1 mais de duas colunas de sal\xE1rio ou a identifica\xE7\xE3o est\xE1 amb\xEDgua.");
  else unnamedSalaries.forEach((column, index) => columns.set(remainingSalaries[index], column));
  if (errors.length) return { rows, errors };
  const moneyColumns = new Set([...columns].filter(([key]) => MONEY.includes(key)).map(([, column]) => column));
  const footerLabels = /* @__PURE__ */ new Set(["TOTAL", "TOTAIS", "TOTALGERAL", "SOMA"]);
  const footerLabelColumns = new Set(["branch", "employee"].filter((key) => columns.has(key)).map((key) => columns.get(key)));
  const footerCandidate = (source) => source.some((value, column) => moneyColumns.has(column) && !blank(value)) && source.every((value, column) => moneyColumns.has(column) || blank(value) || footerLabelColumns.has(column) && footerLabels.has(normalize(value)));
  let count2 = 0;
  const total = Object.fromEntries(MONEY.map((key) => [key, 0n]));
  for (let index = headerLine + 1; index < matrix.length; index++) {
    const source = matrix[index];
    if (!Array.isArray(source)) {
      problem(index + 1, "Arquivo", "Linha inv\xE1lida.");
      continue;
    }
    if (source.every(blank)) continue;
    if (totals) {
      problem(index + 1, "Rodap\xE9", "A linha de totais deve ser a \xFAltima linha preenchida do relat\xF3rio.");
      continue;
    }
    if (footerCandidate(source)) {
      if (!rows.length) {
        problem(index + 1, "Rodap\xE9", "A linha de totais precisa aparecer depois das pessoas da base.");
        continue;
      }
      totals = { source_row: index + 1, ...Object.fromEntries(MONEY.map((key) => [key, null])) };
      for (const key of MONEY) {
        const column = columns.get(key);
        if (column === void 0 || blank(source[column])) continue;
        try {
          totals[key] = money2(financialScalar(source[column]), key);
        } catch (error) {
          problem(index + 1, LABELS[key], error.message);
        }
      }
      for (const key of MONEY) {
        if (totals[key] === null) continue;
        const values = rows.map((row2) => row2[key]);
        if (values.some((value) => value === null)) problem(index + 1, LABELS[key], "O total do rodap\xE9 n\xE3o pode ser conferido porque h\xE1 valores n\xE3o informados nas pessoas.");
        else if (values.reduce((sum, value) => sum + BigInt(value), 0n) !== BigInt(totals[key])) problem(index + 1, LABELS[key], "O total do rodap\xE9 difere da soma dos valores das pessoas. Confira a f\xF3rmula e salve a planilha novamente.");
      }
      continue;
    }
    if (++count2 > MAX_ROWS) {
      problem(index + 1, "Arquivo", "A base excede 5.000 registros.");
      break;
    }
    const before = errors.length;
    if (source.length > 100 || source.slice(head.length).some((value) => !blank(value))) problem(index + 1, "Arquivo", "H\xE1 valores fora das colunas do cabe\xE7alho.");
    for (let column = 0; column < source.length; column++) try {
      (moneyColumns.has(column) ? financialScalar : scalar2)(source[column]);
    } catch (error) {
      problem(index + 1, `Coluna ${column + 1}`, error.message);
    }
    const row = { source_row: index + 1, branch: "", employee: "", sector: "", admitted_on: null, birthday_on: null, salary_base_cents: null, payroll_salary_cents: null, transport_cents: null, advance_cents: null, cost_allowance_cents: null, total_cents: null, count_label: null };
    for (const [key, column] of columns) {
      try {
        const value = (MONEY.includes(key) ? financialScalar : scalar2)(source[column]);
        if (MONEY.includes(key)) row[key] = money2(value, key);
        else if (key === "admitted_on" || key === "birthday_on") row[key] = date2(value, excel1904);
        else {
          row[key] = String(value).trim().replace(/\s+/g, " ");
          if (row[key].length > (key === "employee" ? 300 : 150)) throw new Error("Texto excede o limite de caracteres.");
          if (key === "employee" && !row[key]) throw new Error("Nome do funcion\xE1rio obrigat\xF3rio.");
          if (key === "count_label" && !row[key]) row[key] = null;
        }
      } catch (error) {
        problem(index + 1, LABELS[key], error.message);
      }
    }
    if (!row.employee && !errors.slice(before).some((error) => error.column === "Funcion\xE1rio")) problem(index + 1, "Funcion\xE1rio", "Nome do funcion\xE1rio obrigat\xF3rio; linhas de totais n\xE3o pertencem \xE0 base.");
    if (errors.length === before) {
      for (const key of MONEY) {
        if (row[key] !== null) {
          total[key] += BigInt(Math.abs(row[key]));
          if (total[key] > BigInt(Number.MAX_SAFE_INTEGER)) problem(index + 1, LABELS[key], "O total da coluna excede o limite de precis\xE3o.");
        }
      }
      if (errors.length === before) rows.push(row);
    }
    if (errors.length >= 100) break;
  }
  if (!rows.length && !errors.length) problem(headerLine + 2, "Arquivo", "A base n\xE3o cont\xE9m funcion\xE1rios. Uma base vazia n\xE3o substitui a posi\xE7\xE3o atual.");
  return { rows: errors.length ? [] : rows, totals: errors.length ? null : totals, errors: errors.slice(0, 100) };
}

// src/lib/costs-parser.mjs
var MAX_ROWS2 = 5e3;
var MAX_FRACTION = 6;
var MAX_WHOLE_DIGITS = 12;
var normalize2 = (value) => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
var aliases2 = {
  code: ["Produto: c\xF3digo", "C\xF3digo do produto", "C\xF3digo", "C\xF3d. produto"],
  product: ["Produto: nome", "Nome do produto", "Produto", "Descri\xE7\xE3o do produto"],
  weight: ["peso", "Peso do produto"],
  unit_cost: ["custo atual", "Custo unit\xE1rio", "Custo por item"]
};
var headers2 = new Map(Object.entries(aliases2).flatMap(([key, values]) => values.map((value) => [normalize2(value), key])));
var correction = "Confira o c\xF3digo, o nome, o peso e o custo da linha. Salve uma c\xF3pia somente com valores e analise novamente.";
function scalar3(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if ("formula" in value || "sharedFormula" in value) throw new Error("F\xF3rmulas n\xE3o s\xE3o permitidas. Salve uma c\xF3pia somente com valores.");
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text ?? "").join("");
    if ("text" in value && "hyperlink" in value) return value.text;
    throw new Error("C\xE9lula n\xE3o suportada. Salve uma c\xF3pia somente com valores.");
  }
  if (typeof value === "string" && /^\s*[=+@]/.test(value)) throw new Error("Conte\xFAdo interpret\xE1vel como f\xF3rmula. Salve somente valores.");
  if (!["string", "number"].includes(typeof value)) throw new Error("C\xE9lula n\xE3o suportada.");
  return value;
}
function text2(value, required = true) {
  const result = String(scalar3(value)).trim();
  if (required && !result) throw new Error("Campo obrigat\xF3rio vazio.");
  if (result.length > 500 || /[\u0000-\u001f\u007f]/.test(result)) throw new Error("Texto inv\xE1lido ou maior que 500 caracteres.");
  return result;
}
function code(value) {
  value = scalar3(value);
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new Error("O c\xF3digo num\xE9rico precisa ser um inteiro exato e positivo.");
  const result = text2(value);
  if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)[eE][+-]?\d+$/.test(result)) throw new Error("C\xF3digo em nota\xE7\xE3o cient\xEDfica. Exporte o c\xF3digo como texto.");
  return result;
}
function trimmedDecimal(value) {
  let [whole, fraction = ""] = value.split(".");
  whole = whole.replace(/^0+(?=\d)/, "");
  fraction = fraction.replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
function numericDecimal(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Informe um n\xFAmero positivo ou zero.");
  if (value >= 1e12) throw new Error("Use at\xE9 12 d\xEDgitos inteiros e seis casas decimais, sem arredondamento.");
  const original = trimmedDecimal(String(value));
  if (/^\d+(?:\.\d{1,6})?$/.test(original)) return original;
  const decimal2 = value.toFixed(MAX_FRACTION), nearest = Number(decimal2);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const exponent = view.getUint32(0) >>> 20 & 2047;
  const ulp = exponent ? 2 ** (exponent - 1023 - 52) : Number.MIN_VALUE;
  if (nearest !== 0 && Number.isFinite(nearest) && 2 * ulp <= 1e-9 && Math.abs(value - nearest) <= 2 * ulp) return trimmedDecimal(decimal2);
  throw new Error("N\xFAmero fora do limite de seis casas decimais, sem arredondamento.");
}
function parseCostDecimal(value, { optional = false, currency = false } = {}) {
  value = scalar3(value);
  if (value === "") {
    if (optional) return null;
    throw new Error("Custo obrigat\xF3rio vazio; informe zero somente quando o custo for realmente zero.");
  }
  let canonical;
  if (typeof value === "number") {
    canonical = numericDecimal(value);
  } else {
    let raw = String(value).trim();
    if (currency) raw = raw.replace(/^R\$\s*/, "");
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/.test(raw)) throw new Error("Use n\xFAmero brasileiro, por exemplo 1.234,5678.");
    canonical = raw.replaceAll(".", "").replace(",", ".");
  }
  let [whole, fraction = ""] = trimmedDecimal(canonical).split(".");
  if (whole.length > MAX_WHOLE_DIGITS || fraction.length > MAX_FRACTION) throw new Error("Use at\xE9 12 d\xEDgitos inteiros e seis casas decimais, sem arredondamento.");
  return fraction ? `${whole}.${fraction}` : whole;
}
function isCostCodeHeader(value) {
  try {
    return headers2.get(normalize2(scalar3(value))) === "code";
  } catch {
    return false;
  }
}
function readCostCodeCell(value, numFmt) {
  if (typeof value !== "number") return value;
  const result = code(value), format = String(numFmt ?? "").trim();
  if (!format || ["GENERAL", "@"].includes(format.toUpperCase())) return result;
  if (!/^0{1,150}$/.test(format)) throw new Error("Formato do c\xF3digo n\xE3o suportado. Exporte os c\xF3digos como texto.");
  return result.padStart(format.length, "0");
}
function validateCostRows(matrix) {
  const rows = [], errors = [];
  const issue = (line, column, problem) => errors.push({ line, column, problem, correction });
  if (!Array.isArray(matrix) || matrix.length < 2 || matrix.length > MAX_ROWS2 + 1 || !Array.isArray(matrix[0]) || matrix[0].length > 100) {
    issue(1, "Arquivo", "Informe de 1 a 5.000 itens de custo.");
    return { rows, errors };
  }
  const mapped = /* @__PURE__ */ new Map();
  for (const [index, value] of (matrix[0] ?? []).entries()) {
    try {
      const key = headers2.get(normalize2(scalar3(value)));
      if (key && mapped.has(key)) issue(1, String(value), "Coluna duplicada ou amb\xEDgua.");
      else if (key) mapped.set(key, index);
    } catch (error) {
      issue(1, "Cabe\xE7alho", error.message);
    }
  }
  for (const key of ["code", "product", "unit_cost"]) if (!mapped.has(key)) issue(1, aliases2[key][0], "Coluna obrigat\xF3ria ausente.");
  if (errors.length) return { rows, errors };
  for (let index = 1; index < matrix.length; index++) {
    const source = matrix[index], line = index + 1;
    if (!Array.isArray(source) || source.length > 100) {
      issue(line, "Linha", "A linha excede 100 colunas ou possui estrutura inv\xE1lida.");
      continue;
    }
    if (source.every((value) => value == null || value === "")) continue;
    try {
      source.forEach(scalar3);
      if (source.slice(matrix[0].length).some((value) => value != null && value !== "")) throw new Error("H\xE1 valores fora das colunas do cabe\xE7alho.");
      const get = (key) => mapped.has(key) ? source[mapped.get(key)] : "";
      const item = { line_number: line, code: code(get("code")), product: text2(get("product")), weight_kg: parseCostDecimal(get("weight"), { optional: true }), unit_cost: parseCostDecimal(get("unit_cost"), { optional: true, currency: true }) };
      rows.push(item);
    } catch (error) {
      issue(line, "Item de custo", error.message);
    }
  }
  if (!rows.length && !errors.length) issue(2, "Arquivo", "N\xE3o h\xE1 itens de custo no relat\xF3rio.");
  return { rows, errors };
}

// supabase/functions/business-import/costs-contract.mjs
var UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
var isUuid = (value) => typeof value === "string" && UUID.test(value);
var decimal = (value) => value === null || typeof value === "string" && /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value);
var signedQuantity = (value) => value === null || typeof value === "string" && /^-?\d{1,10}(?:\.\d{1,6})?$/.test(value);
var amount = (value) => value === null || Number.isSafeInteger(value);
var count = (value, maximum = 5e3) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
var normalizeDecimal = (value) => value === null ? null : value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
var nullableUuid = (value) => value === null || isUuid(value);
var boundedText = (value) => typeof value === "string" && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
var sameDecimal = (first, second) => decimal(first) && decimal(second) && normalizeDecimal(first) === normalizeDecimal(second);
function validCostResolutions(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 5e3 && Object.entries(value).every(([key, line]) => key.length > 0 && key.length <= 500 && key === key.trim() && !/[\u0000-\u001f\u007f]/.test(key) && Number.isSafeInteger(line) && line >= 2 && line <= 5001);
}
function validCostPreview(preview, rawRows, reference, resolutions) {
  if (!preview || preview.format_version !== "costs-v1" || preview.reference_date !== reference || preview.row_count !== rawRows.length || !nullableUuid(preview.previous_import_id) || typeof preview.can_commit !== "boolean" || !Array.isArray(preview.rows) || !Array.isArray(preview.conflicts)) return false;
  const groups = /* @__PURE__ */ new Map();
  for (const row of rawRows) groups.set(row.code, [...groups.get(row.code) ?? [], row]);
  const needsChoice = (group) => new Set(group.map((row) => JSON.stringify([row.product, normalizeDecimal(row.unit_cost)]))).size > 1;
  const expectedConflicts = [...groups.values()].filter(needsChoice).length;
  const integerFields = ["item_count", "zero_cost_count", "missing_weight_count", "missing_cost_count", "duplicate_row_count", "duplicate_code_count", "conflicting_cost_code_count", "unresolved_count", "new_count", "changed_count", "unchanged_count", "removed_count", "exact_duplicate_count"];
  if (!integerFields.every((key) => count(preview[key])) || preview.item_count !== groups.size || preview.rows.length !== groups.size || preview.duplicate_row_count !== rawRows.length - groups.size || preview.conflicts.length !== preview.conflicting_cost_code_count || preview.conflicts.length !== expectedConflicts || preview.duplicate_code_count !== [...groups.values()].filter((group) => group.length > 1).length || preview.new_count + preview.changed_count + preview.unchanged_count !== preview.item_count) return false;
  const seen = /* @__PURE__ */ new Set(), conflicted = /* @__PURE__ */ new Map();
  const choiceFor = (key) => Object.hasOwn(resolutions, key) ? resolutions[key] : null;
  for (const item of preview.conflicts) {
    const group = groups.get(item?.code);
    if (!group || !needsChoice(group) || conflicted.has(item.code) || !boundedText(item.product) || !Array.isArray(item.options) || item.options.length !== group.length || !item.options.every((option) => group.some((row) => row.line_number === option?.line_number && sameDecimal(row.unit_cost, option.unit_cost) && sameDecimal(row.weight_kg, option.weight_kg))) || new Set(item.options.map((option) => option.line_number)).size !== item.options.length || !(item.selected_line_number === null || group.some((row) => row.line_number === item.selected_line_number)) || item.selected_line_number !== choiceFor(item.code)) return false;
    conflicted.set(item.code, item);
  }
  if (Object.keys(resolutions).some((key) => !conflicted.has(key))) return false;
  for (const item of preview.rows) {
    const group = groups.get(item?.code), conflict = conflicted.get(item?.code);
    if (!group || seen.has(item.code) || !boundedText(item.product) || !decimal(item.unit_cost) || !decimal(item.weight_kg) || !Array.isArray(item.source_lines) || item.source_lines.length !== group.length || new Set(item.source_lines).size !== group.length || item.source_lines.some((line) => !group.some((row) => row.line_number === line)) || item.duplicate_count !== group.length - 1 || typeof item.cost_conflict !== "boolean" || item.cost_conflict !== !!conflict || typeof item.resolved !== "boolean" || item.selected_line_number !== choiceFor(item.code)) return false;
    const selected = group.find((row) => row.line_number === item.line_number);
    if (!selected || Object.hasOwn(resolutions, item.code) && item.line_number !== resolutions[item.code]) return false;
    if (conflict && item.selected_line_number === null) {
      if (item.resolved || item.unit_cost !== null || item.weight_kg !== null) return false;
    } else if (!item.resolved || item.product !== selected.product || !sameDecimal(item.unit_cost, selected.unit_cost)) return false;
    if (!(conflict && item.selected_line_number === null) && !(item.weight_kg === null && item.weight_conflict === true && item.selected_line_number === null) && !sameDecimal(item.weight_kg, selected.weight_kg)) return false;
    seen.add(item.code);
  }
  const unresolved = [...conflicted.values()].filter((item) => item.selected_line_number === null).length;
  return preview.unresolved_count === unresolved && preview.can_commit === (unresolved === 0) && preview.zero_cost_count === preview.rows.filter((row) => normalizeDecimal(row.unit_cost) === "0").length && preview.missing_cost_count === preview.rows.filter((row) => row.unit_cost === null).length && preview.missing_weight_count === preview.rows.filter((row) => row.weight_kg === null).length;
}
function validCostRecalculation(preview, costImportId, month) {
  if (!preview || preview.format_version !== "costs-recalculation-v1" || preview.month !== month || preview.cost_import_id !== costImportId || !nullableUuid(preview.previous_import_id) || typeof preview.can_apply !== "boolean" || !count(preview.row_count) || !Array.isArray(preview.rows) || preview.rows.length !== preview.row_count || typeof preview.revision !== "string" || !preview.revision.length || preview.revision.length > 256 || !preview.totals || !["previous_cost_cents", "new_cost_cents", "previous_margin_cents", "new_margin_cents"].every((key) => amount(preview.totals[key]))) return false;
  const counters = ["matched_count", "missing_code_count", "missing_quantity_count", "invalid_quantity_count", "missing_cost_count", "zero_cost_count", "missing_components_count"];
  if (!counters.every((key) => count(preview[key], preview.row_count))) return false;
  if (preview.source !== null && (!isUuid(preview.source?.import_id) || preview.source.import_id !== preview.previous_import_id || preview.source.month !== month || !boundedText(preview.source.file_name))) return false;
  if (preview.source === null && preview.previous_import_id !== null) return false;
  if (!isUuid(preview.cost_source?.import_id) || preview.cost_source.import_id !== costImportId || !/^\d{4}-\d{2}-\d{2}$/.test(preview.cost_source.reference_date ?? "") || !boundedText(preview.cost_source.file_name)) return false;
  const ids = /* @__PURE__ */ new Set();
  for (const row of preview.rows) {
    if (!isUuid(row?.id) || ids.has(row.id) || !Number.isSafeInteger(row.line_number) || row.line_number < 2 || row.line_number > 5001 || !["code", "product", "invoice", "branch"].every((key) => boundedText(row[key])) || !signedQuantity(row.quantity) || !decimal(row.unit_cost) || !["previous_cost_cents", "new_cost_cents", "previous_margin_cents", "new_margin_cents"].every((key) => amount(row[key])) || !Array.isArray(row.error_codes) || !row.error_codes.every((code2) => typeof code2 === "string" && /^[A-Z_]{1,100}$/.test(code2))) return false;
    ids.add(row.id);
  }
  if (preview.can_apply) {
    if (!preview.source || !preview.row_count || counters.filter((key) => key !== "matched_count").some((key) => preview[key] !== 0) || preview.rows.some((row) => row.error_codes.length || row.new_cost_cents === null || row.new_margin_cents === null || row.quantity === null || Number(row.quantity) === 0 || row.unit_cost === null || Number(row.unit_cost) <= 0)) return false;
    for (const key of ["new_cost_cents", "new_margin_cents"]) if (preview.totals[key] === null || preview.rows.reduce((sum, row) => sum + BigInt(row[key]), 0n) !== BigInt(preview.totals[key])) return false;
  }
  return true;
}

// supabase/functions/business-import/handler.mjs
var UUID2 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var uuidValue = (value) => typeof value === "string" && UUID2.test(value);
var FAILURE = "N\xE3o foi poss\xEDvel confirmar a opera\xE7\xE3o. Atualize o hist\xF3rico antes de tentar novamente.";
var INVALID = "Solicita\xE7\xE3o inv\xE1lida. Selecione novamente o relat\xF3rio completo.";
var CORRECTION = "Confira os cabe\xE7alhos e salve uma c\xF3pia somente com valores.";
var HR_CORRECTION = "Confira os cabe\xE7alhos e os totais. Se houver f\xF3rmulas financeiras, recalcule e salve o arquivo no Excel antes de importar.";
function origins(raw) {
  const values = String(raw || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw Error("origins");
  return new Set(values.map((value) => {
    const url = new URL(value);
    if (url.origin !== value || !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw Error("origin");
    return value;
  }));
}
async function bodyOf(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw Error("body");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 3 * 1024 * 1024)) throw Error("size");
  const reader = request.body?.getReader();
  if (!reader) throw Error("body");
  const parts = [];
  let size = 0;
  try {
    for (; ; ) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 3 * 1024 * 1024) {
        await reader.cancel();
        throw Error("size");
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("body");
  return body;
}
function decode(encoded) {
  if (typeof encoded !== "string" || !encoded.length || encoded.length > 4 * Math.ceil(MAX_FILE_BYTES / 3) || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw Error("base64");
  const binary = atob(encoded);
  if (!binary.length || binary.length > MAX_FILE_BYTES || btoa(binary) !== encoded) throw Error("file");
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function sessionId(token, id) {
  const part = token.split(".")[1];
  if (!part) throw Error("claims");
  const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  if (claims.sub !== id || !UUID2.test(claims.session_id ?? "")) throw Error("claims");
  return claims.session_id;
}
var problems = (errors, correction2 = CORRECTION) => errors.slice(0, 100).map((row) => ({ line: Number.isSafeInteger(row.line) && row.line >= 0 && row.line <= 5021 ? row.line : 0, column: String(row.column || "Arquivo").slice(0, 100), problem: String(row.problem || "Linha inv\xE1lida.").slice(0, 400), correction: String(row.correction || correction2).slice(0, 400) }));
function createBusinessGateway({ env, fetch: fetcher = globalThis.fetch, loadWorkbook, log = () => {
} }) {
  return async (request) => {
    let allowed;
    try {
      allowed = origins(env("ALLOWED_ORIGINS"));
    } catch {
      return new Response(JSON.stringify({ error: FAILURE }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    const origin = request.headers.get("origin");
    if (!origin || !allowed.has(origin)) return new Response(JSON.stringify({ error: "Origem n\xE3o autorizada." }), { status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" } });
    const headers3 = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": origin, Vary: "Origin" };
    const respond = (status, value) => new Response(JSON.stringify(value), { status, headers: headers3 });
    if (request.method === "OPTIONS") {
      const requested = (request.headers.get("access-control-request-headers") || "").toLowerCase().split(",").map((v) => v.trim()).filter(Boolean);
      if (request.headers.get("access-control-request-method") !== "POST" || requested.some((v) => !["authorization", "content-type", "apikey", "x-client-info"].includes(v))) return respond(403, { error: INVALID });
      return new Response(null, { status: 204, headers: { ...headers3, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Max-Age": "600" } });
    }
    if (request.method !== "POST") return respond(405, { error: "M\xE9todo n\xE3o permitido." });
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/i)?.[1];
    if (!token) return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
    let base, serviceKey, anonKey;
    try {
      const url = new URL(env("SUPABASE_URL"));
      serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
      anonKey = env("SUPABASE_ANON_KEY");
      if (!serviceKey || !anonKey || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw Error("config");
      base = url.origin;
    } catch {
      return respond(503, { error: FAILURE });
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25e3)]);
    async function call(path, { method = "POST", service = false, data } = {}) {
      const result = await fetcher(`${base}${path}`, { method, headers: { apikey: service ? serviceKey : anonKey, Authorization: `Bearer ${service ? serviceKey : token}`, "Content-Type": "application/json" }, body: data === void 0 ? void 0 : JSON.stringify(data), signal });
      let payload = null;
      try {
        payload = await result.json();
      } catch {
      }
      return { ok: result.ok, status: result.status, payload };
    }
    let activationCode = "P0032";
    function fail(result) {
      const code2 = result.payload?.code;
      if (code2 === "42501") return respond(403, { code: code2, error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      if (code2 === "40001") return respond(409, { code: code2, error: "A base mudou. Analise o relat\xF3rio novamente." });
      if (["PGRST202", "42P01", "42883", "P0044", "P0045"].includes(code2)) return respond(409, { code: activationCode, error: "Ative a atualiza\xE7\xE3o do banco antes de importar." });
      if (["22023", "22007", "22008", "23514", "22003", "22P02"].includes(code2)) return respond(400, { code: "22023", error: "Confira a refer\xEAncia e as linhas do relat\xF3rio." });
      if (result.status === 401) return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
      log("upstream_unavailable");
      return respond(503, { error: FAILURE });
    }
    try {
      const auth = await call("/auth/v1/user", { method: "GET" });
      if (!auth.ok) return auth.status === 401 || auth.status === 403 ? respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." }) : fail(auth);
      if (!UUID2.test(auth.payload?.id ?? "")) throw Error("identity");
      let verifiedSession;
      try {
        verifiedSession = sessionId(token, auth.payload.id);
      } catch {
        return respond(401, { error: "Sua sess\xE3o expirou. Entre novamente." });
      }
      const access = await call("/rest/v1/rpc/current_access", { data: {} });
      if (!access.ok) return fail(access);
      const permissions = access.payload?.permissions, has = (resource, action = "read") => Array.isArray(permissions) && permissions.some((p) => p?.resource === resource && p.action === action);
      if (access.payload?.profile?.id !== auth.payload.id || access.payload.profile.enabled !== true || !has("importar_bases") || !(has("fechamento", "import") || has("rh_dp", "import") || has("custos", "import"))) return respond(403, { code: "42501", error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      let body;
      try {
        body = await bodyOf(request);
      } catch {
        return respond(400, { error: INVALID });
      }
      if (!["preview", "commit"].includes(body.action) || !["commercial", "hr", "costs", "costs_recalculation"].includes(body.mode)) return respond(400, { error: INVALID });
      const commercial = body.mode === "commercial", costs = body.mode === "costs", recalculation = body.mode === "costs_recalculation";
      if (!(commercial ? has("fechamento", "import") && has("faturamento") : costs || recalculation ? has("custos", "import") && has("margens") && (!recalculation || has("fechamento", "import") && has("faturamento")) : has("rh_dp", "import") && has("rh_dp") && has("rh_dp", "write"))) return respond(403, { code: "42501", error: "Seu perfil n\xE3o tem permiss\xE3o para esta opera\xE7\xE3o." });
      activationCode = recalculation ? "P0045" : costs ? "P0044" : "P0032";
      if (recalculation) {
        if (Object.keys(body).some((key) => !["action", "mode", "month", "cost_import_id", "previous_import_id", "request_id", "complete"].includes(key)) || !uuidValue(body.cost_import_id) || typeof body.month !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])-01$/.test(body.month) || Object.hasOwn(body, "previous_import_id") && !uuidValue(body.previous_import_id) || Object.hasOwn(body, "request_id") && !uuidValue(body.request_id) || Object.hasOwn(body, "complete") && typeof body.complete !== "boolean" || body.action === "commit" && (body.complete !== true || !uuidValue(body.previous_import_id) || !uuidValue(body.request_id))) return respond(400, { error: INVALID });
        try {
          if (parseCivilDate(body.month) !== body.month) throw Error("date");
        } catch {
          return respond(400, { error: INVALID });
        }
        if (body.action === "preview") {
          const preview = await call("/rest/v1/rpc/preview_product_cost_recalculation", { data: { p_cost_import_id: body.cost_import_id, p_month: body.month } });
          if (!preview.ok) return fail(preview);
          if (!validCostRecalculation(preview.payload, body.cost_import_id, body.month)) throw Error("preview");
          return respond(200, preview.payload);
        }
        const committed2 = await call("/rest/v1/rpc/commit_product_cost_recalculation_from_gateway", { service: true, data: { p_user_id: auth.payload.id, p_session_id: verifiedSession, p_cost_import_id: body.cost_import_id, p_month: body.month, p_previous_import_id: body.previous_import_id, p_request_id: body.request_id } });
        if (!committed2.ok) return fail(committed2);
        const result = committed2.payload;
        if (result?.format_version !== "costs-recalculation-v1" || !uuidValue(result.import_id) || result.source_import_id !== body.previous_import_id || result.cost_import_id !== body.cost_import_id || result.month !== body.month || result.request_id !== body.request_id || !Number.isSafeInteger(result.row_count) || result.row_count < 1 || result.row_count > MAX_ROWS || typeof result.idempotent !== "boolean") throw Error("commit");
        return respond(200, result);
      }
      if (Object.keys(body).some((k) => !["action", "mode", "file_name", "file_base64", "month", "reference_date", "previous_import_id", "complete", ...costs ? ["resolutions"] : []].includes(k)) || typeof body.file_name !== "string" || !body.file_name || body.file_name.length > 250 || body.file_name !== body.file_name.trim() || /[/\\\u0000-\u001f\u007f]/.test(body.file_name)) return respond(400, { error: INVALID });
      const resolutions = costs ? Object.hasOwn(body, "resolutions") ? body.resolutions : {} : null;
      if (costs && !validCostResolutions(resolutions)) return respond(400, { error: INVALID });
      if (costs && Object.hasOwn(body, "previous_import_id") && body.previous_import_id !== null && !uuidValue(body.previous_import_id)) return respond(400, { error: INVALID });
      const reference = commercial ? body.month : body.reference_date;
      if (typeof reference !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reference) || commercial && !reference.endsWith("-01") || (commercial ? Object.hasOwn(body, "reference_date") : Object.hasOwn(body, "month")) || "previous_import_id" in body && body.previous_import_id !== null && !UUID2.test(body.previous_import_id ?? "") || "complete" in body && typeof body.complete !== "boolean" || body.action === "commit" && (body.complete !== true || !Object.hasOwn(body, "previous_import_id"))) return respond(400, { error: INVALID });
      if (costs) {
        try {
          if (parseCivilDate(reference) !== reference) throw Error("date");
        } catch {
          return respond(400, { error: INVALID });
        }
      }
      if (!/\.(xlsx|xlsm|csv)$/i.test(body.file_name)) return respond(400, { error: "Selecione .xlsx, .xlsm ou .csv. Para .xls, salve uma c\xF3pia como .xlsx." });
      let bytes;
      try {
        bytes = decode(body.file_base64);
      } catch {
        return respond(400, { error: "Selecione um arquivo n\xE3o vazio de at\xE9 2 MiB." });
      }
      let parsed;
      try {
        let matrix, excel1904 = false;
        if (/\.csv$/i.test(body.file_name)) matrix = parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(bytes), commercial || costs ? void 0 : { maxRows: MAX_ROWS + 21 });
        else {
          await validateWorkbookExpandedSize(bytes.buffer);
          const workbook = await loadWorkbook(bytes.buffer, { mode: body.mode });
          matrix = workbook.matrix;
          excel1904 = workbook.excel1904 === true;
        }
        if (!Array.isArray(matrix) || matrix.length > MAX_ROWS + (commercial || costs ? 1 : 21) || matrix.some((row) => !Array.isArray(row) || row.length > 100)) throw Error("size");
        parsed = (commercial ? validateCommercialRows : costs ? validateCostRows : validateHrRows)(matrix, { excel1904 });
      } catch {
        return respond(422, { error: "Importa\xE7\xE3o bloqueada. Nenhum dado foi alterado.", errors: [{ line: 0, column: "Arquivo", problem: commercial || costs ? "N\xE3o foi poss\xEDvel analisar o arquivo. Use uma \xFAnica aba com at\xE9 5.000 linhas e 100 colunas, somente com valores." : "N\xE3o foi poss\xEDvel analisar o arquivo. Use uma \xFAnica aba com at\xE9 5.000 pessoas, uma linha final de totais e 100 colunas.", correction: commercial || costs ? CORRECTION : HR_CORRECTION }] });
      }
      if (parsed.errors.length) return respond(422, { error: "Importa\xE7\xE3o bloqueada. Nenhum dado foi alterado.", errors: problems(parsed.errors, commercial || costs ? CORRECTION : HR_CORRECTION) });
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const referenceArgument = commercial ? { p_month: reference } : costs ? { p_reference_date: reference, p_resolutions: resolutions } : { p_reference_date: reference, p_report_totals: parsed.totals ?? null };
      if (body.action === "preview") {
        const preview = await call(`/rest/v1/rpc/${commercial ? "preview_commercial_import" : costs ? "preview_product_cost_import" : "preview_hr_sheet_import"}`, { data: { p_rows: parsed.rows, ...referenceArgument } });
        if (!preview.ok) return fail(preview);
        if (costs) {
          if (!validCostPreview(preview.payload, parsed.rows, reference, resolutions)) throw Error("preview");
          const { rows: rows2, ...details2 } = preview.payload;
          return respond(200, { rows: rows2, preview: details2, file_sha256: hash, format_version: "costs-v1" });
        }
        if (preview.payload?.row_count !== parsed.rows.length || !(preview.payload.previous_import_id === null || UUID2.test(preview.payload.previous_import_id ?? ""))) throw Error("preview");
        const rows = commercial ? parsed.rows : preview.payload.rows;
        if (!Array.isArray(rows) || rows.length !== parsed.rows.length || !commercial && preview.payload.summary?.total_formula_version !== "rh-reported-total-v1") throw Error("preview");
        const { rows: projectedRows, ...details } = preview.payload;
        return respond(200, { rows, preview: commercial ? preview.payload : details, file_sha256: hash, ...commercial ? {} : { format_version: 4 } });
      }
      const committed = await call(`/rest/v1/rpc/${commercial ? "commit_commercial_import_from_gateway" : costs ? "commit_product_cost_import_from_gateway" : "commit_hr_sheet_import_from_gateway"}`, { service: true, data: { p_user_id: auth.payload.id, p_session_id: verifiedSession, p_file_name: body.file_name, p_file_sha256: hash, p_file_base64: body.file_base64, p_rows: parsed.rows, ...referenceArgument, p_previous_import_id: body.previous_import_id } });
      if (!committed.ok) return fail(committed);
      if (!UUID2.test(committed.payload?.import_id ?? "") || committed.payload.row_count !== parsed.rows.length || costs && (committed.payload.format_version !== "costs-v1" || committed.payload.reference_date !== reference || !Number.isSafeInteger(committed.payload.item_count) || committed.payload.item_count < 1 || committed.payload.item_count > parsed.rows.length || typeof committed.payload.idempotent !== "boolean")) throw Error("commit");
      return respond(200, committed.payload);
    } catch {
      log("request_unavailable");
      return respond(503, { error: FAILURE });
    }
  };
}

// supabase/functions/business-import/index.ts
Deno.serve(createBusinessGateway({
  env: (name) => Deno.env.get(name),
  loadWorkbook: async (buffer, options) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const populated = workbook.worksheets.filter((sheet2) => sheet2.actualRowCount > 0);
    if (populated.length !== 1) throw new Error("Use uma \xFAnica aba com dados.");
    const sheet = populated[0];
    if (sheet.rowCount > 5021 || sheet.columnCount > 100) throw new Error("Limite da planilha excedido.");
    const matrix = [];
    const codeColumn = options?.mode === "costs" ? sheet.getRow(1).values.findIndex(isCostCodeHeader) : -1;
    for (let index = 1; index <= sheet.rowCount; index++) {
      const values = sheet.getRow(index).values.slice(1);
      if (index > 1 && codeColumn > 0) {
        const cell = sheet.getRow(index).getCell(codeColumn);
        values[codeColumn - 1] = readCostCodeCell(cell.value, cell.numFmt);
      }
      matrix.push(values);
    }
    return { matrix, excel1904: Boolean(workbook.properties.date1904) };
  },
  log: (event) => console.warn(`business-import:${event}`)
}));
