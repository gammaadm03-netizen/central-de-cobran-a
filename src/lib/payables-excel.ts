import type { PayableFilters, PayableTitle } from './payables';
import { comparisonRanges, financialWeekLabel, monthBounds, previousMonth } from './financial-dates.ts';

export const MAX_PAYABLE_WORKBOOK_ROWS = 20000;
export const PAYABLE_EXPORT_HEADERS = ['Centro de Custo Macro', 'Nº Lançamento', 'Histórico/Favorecido', 'Plano de Contas', 'Filial', 'Banco/Conta', 'Emissão', 'Vencimento', 'Semana Financeira', 'Valor', 'Status', 'Situação', 'Origem', 'Data baixa automática'] as const;
export const PAYABLE_FINANCIAL_HEADERS = ['Valor pago histórico', 'Saldo em aberto', 'Status financeiro', 'Último pagamento', 'Banco do último pagamento', 'Crédito por pagamento excedente'] as const;
const CURRENCY = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
const PERCENTAGE = '0.00%;[Red]-0.00%';
const MAX_EXCEL_CENTS = 999999999999999n;
const statusLabels: Record<PayableTitle['status'], string> = { NEW: 'Novo', OPEN: 'Em aberto', SETTLED_IMPORT: 'Quitado por importação' };
const TIMEZONE = 'America/Sao_Paulo';
const SETTLEMENT_NOTE = 'A data de baixa automática registra quando o título desapareceu de um relatório completo importado; não é a data real de pagamento e não comprova pagamento ou compensação bancária.';
const UNKNOWN_FINANCIAL = 'INFORMAÇÃO INDISPONÍVEL';
const financialStatusLabels = { OPEN: 'Em aberto', PARTIAL: 'Pendência de registro anterior', PAID: 'Pago', OVERPAID: 'Pagamento excedente — revisar', PENDING_RECONCILIATION: 'Aguardando conciliação' } as const;

export interface PaymentExportRow {
  id: string;
  title_id: string;
  entry_number: string;
  description: string;
  branch: string;
  macro_snapshot: string;
  amount_cents: number;
  paid_on: string;
  bank_label: string;
  created_at: string;
  created_by: string;
  cancelled_at: string | null;
  title_status?: string;
  financial_status?: string;
  effective_macro?: string;
  review_status?: string;
}

interface FinancialFields {
  paid_cents?: number;
  outstanding_cents?: number;
  overpaid_cents?: number;
  financial_status?: keyof typeof financialStatusLabels;
  last_payment_date?: string | null;
  last_payment_bank?: string | null;
}

export interface PayablesWorkbookOptions {
  month: string;
  filters: PayableFilters;
  fullMonth: boolean;
  generatedAt: string;
  importId: string | null;
  currentRange?: { start: string; end: string };
  previousRange?: { start: string; end: string };
  payments?: PaymentExportRow[];
}

interface Totals { count: number; openCount: number; settledCount: number; total: bigint; open: bigint; settled: bigint; paid: bigint; overpaid: bigint; unknownPaidCount: number; unknownOverpaidCount: number; legacyOpenCount: number }
const emptyTotals = (): Totals => ({ count: 0, openCount: 0, settledCount: 0, total: 0n, open: 0n, settled: 0n, paid: 0n, overpaid: 0n, unknownPaidCount: 0, unknownOverpaidCount: 0, legacyOpenCount: 0 });

function checkedCents(value: bigint): number {
  if (value > MAX_EXCEL_CENTS || value < -MAX_EXCEL_CENTS) {
    throw new Error('O Excel não preserva todos os centavos de um dos valores ou totais, pois aceita até 15 algarismos. A exportação foi interrompida para evitar arredondamento. Restrinja os filtros ou use CSV.');
  }
  return Number(value) / 100;
}

function add(totals: Totals, row: PayableTitle) {
  const value = BigInt(row.amount_cents), financial = row as PayableTitle & FinancialFields;
  totals.count++; totals.total += value;
  if (row.status === 'SETTLED_IMPORT') { totals.settledCount++; totals.settled += value; }
  if (financial.outstanding_cents !== undefined) {
    totals.open += BigInt(financial.outstanding_cents);
    if (financial.outstanding_cents > 0) totals.openCount++;
  } else {
    totals.legacyOpenCount++;
    if (row.status !== 'SETTLED_IMPORT') { totals.openCount++; totals.open += value; }
  }
  if (financial.paid_cents === undefined) totals.unknownPaidCount++;
  else totals.paid += BigInt(financial.paid_cents);
  if (financial.overpaid_cents === undefined) totals.unknownOverpaidCount++;
  else totals.overpaid += BigInt(financial.overpaid_cents);
}

function validateTotals(totals: Totals) {
  for (const value of [totals.total, totals.open, totals.settled, totals.paid, totals.overpaid]) checkedCents(value);
}

function validateFinancial(row: PayableTitle) {
  const financial = row as PayableTitle & FinancialFields;
  for (const value of [financial.paid_cents, financial.outstanding_cents, financial.overpaid_cents]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Um valor financeiro está incompleto ou inválido. Atualize a conciliação e tente novamente.');
    checkedCents(BigInt(value));
  }
  if (financial.financial_status !== undefined && !Object.hasOwn(financialStatusLabels, financial.financial_status)) throw new Error('Um status financeiro está inválido. Atualize a conciliação e tente novamente.');
  if (financial.last_payment_date !== undefined && financial.last_payment_date !== null) excelCivilDate(financial.last_payment_date);
  if (financial.last_payment_bank !== undefined && financial.last_payment_bank !== null && typeof financial.last_payment_bank !== 'string') throw new Error('O banco do último pagamento está inválido.');
  return financial;
}

function excelCivilDate(value: string): Date {
  // monthBounds/addCivilDays/financialWeek reject impossible civil dates too.
  financialWeekLabel(value);
  if (value < '1900-01-01') throw new Error('O Excel não representa corretamente uma das datas anteriores a 1900. Use CSV para preservar a data original.');
  return new Date(`${value}T12:00:00.000Z`);
}

function excelSaoPauloTime(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) throw new Error('Uma data e hora do relatório é inválida. Atualize os dados e tente novamente.');
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error('Uma data e hora do relatório é inválida. Atualize os dados e tente novamente.');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const component = (name: string) => Number(parts.find(part => part.type === name)?.value);
  const result = new Date(0);
  result.setUTCFullYear(component('year'), component('month') - 1, component('day'));
  result.setUTCHours(component('hour'), component('minute'), component('second'), 0);
  if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() < 1900) throw new Error('Uma data e hora do relatório está fora do intervalo do Excel.');
  return result;
}

function aggregate(rows: PayableTitle[], month: string, selected: { start: string; end: string }) {
  if (rows.length > MAX_PAYABLE_WORKBOOK_ROWS) throw new Error(`O Excel admite até ${MAX_PAYABLE_WORKBOOK_ROWS.toLocaleString('pt-BR')} títulos por período nesta exportação. Restrinja os filtros; nenhum arquivo parcial foi gerado.`);
  const { start, end } = monthBounds(month);
  excelCivilDate(selected.start); excelCivilDate(selected.end);
  if (selected.start < start || selected.end > end || selected.start > selected.end) throw new Error('O período da exportação está fora do mês selecionado.');
  const macros = new Map<string, Totals>(), total = emptyTotals(), ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || row.scope !== 'grupo-consolidado' || !Object.hasOwn(statusLabels, row.status) || !Number.isSafeInteger(row.amount_cents) || row.amount_cents < 0 || typeof row.macro !== 'string' || !row.macro || typeof row.due_date !== 'string' || row.due_date < selected.start || row.due_date > selected.end || ['entry_number', 'description', 'plan', 'branch'].some(key => typeof row[key as keyof PayableTitle] !== 'string')) {
      throw new Error('Os dados da exportação estão incompletos ou mudaram durante a consulta. Atualize a lista e tente novamente.');
    }
    excelCivilDate(row.due_date);
    if (row.issued_on !== null) excelCivilDate(row.issued_on);
    if (row.settled_at !== null) excelSaoPauloTime(row.settled_at);
    if ((row.status === 'SETTLED_IMPORT') !== (row.settled_at !== null)) throw new Error('O histórico de baixa de um título está incompleto. Atualize a lista e tente novamente.');
    checkedCents(BigInt(row.amount_cents));
    validateFinancial(row);
    ids.add(row.id);
    const group = macros.get(row.macro) ?? emptyTotals();
    add(group, row); macros.set(row.macro, group); add(total, row);
  }
  validateTotals(total);
  for (const values of macros.values()) validateTotals(values);
  return { macros, total };
}

function aggregatePayments(rows: PaymentExportRow[], selected: { start: string; end: string }) {
  if (rows.length > MAX_PAYABLE_WORKBOOK_ROWS) throw new Error('O período possui mais de 20.000 pagamentos. Restrinja os filtros; nenhum arquivo parcial foi gerado.');
  const ids = new Set<string>(), macros = new Map<string, { count: number; total: bigint }>();
  let total = 0n;
  for (const row of rows) {
    if (!row || row.cancelled_at !== null || typeof row.id !== 'string' || !row.id || ids.has(row.id) || ['title_id', 'entry_number', 'description', 'branch', 'macro_snapshot', 'bank_label', 'created_by'].some(key => typeof row[key as keyof PaymentExportRow] !== 'string' || !(row[key as keyof PaymentExportRow] as string).trim()) || (row.effective_macro !== undefined && (typeof row.effective_macro !== 'string' || !row.effective_macro.trim())) || !Number.isSafeInteger(row.amount_cents) || row.amount_cents <= 0 || typeof row.paid_on !== 'string' || row.paid_on < selected.start || row.paid_on > selected.end) {
      throw new Error('Os pagamentos estão incompletos, cancelados ou fora do período selecionado. Atualize a conciliação e tente novamente.');
    }
    excelCivilDate(row.paid_on); excelSaoPauloTime(row.created_at); checkedCents(BigInt(row.amount_cents));
    ids.add(row.id); total += BigInt(row.amount_cents);
    const classification = row.effective_macro ?? row.macro_snapshot;
    const macro = macros.get(classification) ?? { count: 0, total: 0n };
    macro.count++; macro.total += BigInt(row.amount_cents); macros.set(classification, macro);
  }
  checkedCents(total);
  for (const macro of macros.values()) checkedCents(macro.total);
  return { total, count: rows.length, macros };
}

export function payablesWorkbookFilename(month: string, fullMonth: boolean): string {
  monthBounds(month);
  return `Contas_a_Pagar_${fullMonth ? 'Lancamento_por_Lancamento' : 'Filtrado'}_${month}.xlsx`;
}

/** Builds a bounded workbook from one revision of the database, without network access. */
export async function buildPayablesWorkbook(currentRows: PayableTitle[], previousRows: PayableTitle[], options: PayablesWorkbookOptions): Promise<import('exceljs').Workbook> {
  if (options.filters.scope !== 'grupo-consolidado') throw new Error('Selecione o grupo consolidado para exportar Contas a Pagar.');
  const range = monthBounds(options.month), priorMonth = previousMonth(options.month);
  const computed = comparisonRanges(options.month, options.filters.start, options.filters.end);
  const selectedRange = options.currentRange ?? computed.current, comparisonRange = options.previousRange ?? computed.previous;
  if (selectedRange.start !== computed.current.start || selectedRange.end !== computed.current.end || comparisonRange.start !== computed.previous.start || comparisonRange.end !== computed.previous.end) throw new Error('Os períodos de comparação não correspondem aos filtros selecionados. Atualize os filtros e tente novamente.');
  if (options.fullMonth && (selectedRange.start !== range.start || selectedRange.end !== range.end || [options.filters.search, options.filters.status, options.filters.macro, options.filters.branch, options.filters.financialStatus ?? '', options.filters.reviewStatus ?? ''].some(value => value.trim()))) throw new Error('A exportação do mês completo exige todos os lançamentos, sem filtros adicionais.');
  const current = aggregate(currentRows, options.month, selectedRange), prior = aggregate(previousRows, priorMonth, comparisonRange);
  const payments = options.payments === undefined ? null : aggregatePayments(options.payments, selectedRange);
  const generated = excelSaoPauloTime(options.generatedAt);
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  book.creator = 'Central Financeira · Grupo Ecoplast'; book.created = new Date(options.generatedAt);
  const lines = book.addWorksheet('TODOS OS LANÇAMENTOS');
  lines.columns = [...PAYABLE_EXPORT_HEADERS, ...(payments ? PAYABLE_FINANCIAL_HEADERS : [])].map((header, index) => ({ header, width: [26, 19, 48, 36, 24, 28, 15, 15, 29, 22, 29, 22, 24, 24, 25, 23, 31, 22, 31, 34][index] }));
  const ordered = [...currentRows].sort((a, b) => a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const relatedEntries = new Map<string, number>();
  for (const item of ordered) {
    const reference = JSON.stringify([item.branch, item.entry_number]);
    relatedEntries.set(reference, (relatedEntries.get(reference) ?? 0) + 1);
    // ExcelJS interprets a string as literal text; formulas require a {formula: ...} object.
    const row = lines.addRow([item.macro, String(item.entry_number), String(item.description), String(item.plan), String(item.branch), item.bank_account ?? '', item.issued_on === null ? null : excelCivilDate(item.issued_on), excelCivilDate(item.due_date), financialWeekLabel(item.due_date), checkedCents(BigInt(item.amount_cents)), statusLabels[item.status], item.source_status ?? '', 'IMPORTAÇÃO DIÁRIA', item.settled_at === null ? null : excelSaoPauloTime(item.settled_at)]);
    for (const column of [7, 8]) row.getCell(column).numFmt = 'dd/mm/yyyy';
    row.getCell(10).numFmt = CURRENCY;
    row.getCell(14).numFmt = 'dd/mm/yyyy hh:mm';
    if (payments) {
      const financial = validateFinancial(item);
      const amount = (value: number | undefined) => value === undefined ? UNKNOWN_FINANCIAL : checkedCents(BigInt(value));
      for (const [index, value] of [amount(financial.paid_cents), amount(financial.outstanding_cents), financial.financial_status === undefined ? UNKNOWN_FINANCIAL : financialStatusLabels[financial.financial_status], financial.last_payment_date === undefined ? UNKNOWN_FINANCIAL : financial.last_payment_date === null ? null : excelCivilDate(financial.last_payment_date), financial.last_payment_bank === undefined ? UNKNOWN_FINANCIAL : financial.last_payment_bank, amount(financial.overpaid_cents)].entries()) row.getCell(15 + index).value = value;
      for (const column of [15, 16, 20]) row.getCell(column).numFmt = CURRENCY;
      row.getCell(18).numFmt = 'dd/mm/yyyy';
    }
  }

  const macro = book.addWorksheet('Resumo por Macro');
  macro.columns = ['Centro de Custo Macro', 'Quantidade', 'Em aberto', 'Quitados por importação', 'Valor em aberto', 'Valor quitado por importação', 'Valor total', 'Participação no total'].map((header, index) => ({ header, width: index === 0 ? 31 : index === 5 ? 31 : 25 }));
  const sortedMacros = [...current.macros.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  for (const name of sortedMacros) {
    const value = current.macros.get(name)!;
    const row = macro.addRow([name, value.count, value.openCount, value.settledCount, checkedCents(value.open), checkedCents(value.settled), checkedCents(value.total), current.total.total === 0n ? '—' : Number(value.total) / Number(current.total.total)]);
    for (const column of [5, 6, 7]) row.getCell(column).numFmt = CURRENCY;
    row.getCell(8).numFmt = PERCENTAGE;
  }
  const totalRow = macro.addRow(['TOTAL', current.total.count, current.total.openCount, current.total.settledCount, checkedCents(current.total.open), checkedCents(current.total.settled), checkedCents(current.total.total), current.total.total === 0n ? '—' : 1]);
  for (const column of [5, 6, 7]) totalRow.getCell(column).numFmt = CURRENCY;
  totalRow.getCell(8).numFmt = PERCENTAGE; totalRow.font = { bold: true };

  const compare = book.addWorksheet('Comparativo por Macro');
  const rangeLabel = (period: { start: string; end: string }) => `${period.start.split('-').reverse().join('/')} a ${period.end.split('-').reverse().join('/')}`;
  compare.columns = ['Centro de Custo Macro', `Quantidade ${rangeLabel(comparisonRange)}`, `Valor ${rangeLabel(comparisonRange)}`, `Quantidade ${rangeLabel(selectedRange)}`, `Valor ${rangeLabel(selectedRange)}`, 'Diferença em reais', 'Variação percentual'].map((header, index) => ({ header, width: index === 0 ? 31 : 29 }));
  const comparisonMacros = [...new Set([...current.macros.keys(), ...prior.macros.keys()])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const comparisonRow = (name: string, earlier: Totals, selected: Totals) => {
    const row = compare.addRow([name, earlier.count, checkedCents(earlier.total), selected.count, checkedCents(selected.total), checkedCents(selected.total - earlier.total), earlier.total === 0n ? '—' : Number(selected.total - earlier.total) / Number(earlier.total)]);
    for (const column of [3, 5, 6]) row.getCell(column).numFmt = CURRENCY;
    row.getCell(7).numFmt = PERCENTAGE;
    return row;
  };
  for (const name of comparisonMacros) comparisonRow(name, prior.macros.get(name) ?? emptyTotals(), current.macros.get(name) ?? emptyTotals());
  comparisonRow('TOTAL', prior.total, current.total).font = { bold: true };

  const summary = book.addWorksheet('Resumo do mês');
  summary.columns = [{ header: 'Informação', width: 41 }, { header: 'Valor', width: 91 }];
  const info = (name: string, value: string | number | Date | null, format?: string) => { const row = summary.addRow([name, value]); if (format) row.getCell(2).numFmt = format; };
  info('Tipo de exportação', options.fullMonth ? 'MÊS COMPLETO — todos os lançamentos, incluindo histórico' : 'FILTROS ATIVOS — mês selecionado');
  info('Escopo', options.filters.scope);
  info('Critério do mês', 'Data de vencimento');
  info('Mês selecionado', options.month);
  info('Primeiro dia do mês', excelCivilDate(range.start), 'dd/mm/yyyy');
  info('Último dia do mês', excelCivilDate(range.end), 'dd/mm/yyyy');
  info('Período selecionado: início', excelCivilDate(selectedRange.start), 'dd/mm/yyyy');
  info('Período selecionado: fim', excelCivilDate(selectedRange.end), 'dd/mm/yyyy');
  info('Comparação: início do mês anterior', excelCivilDate(comparisonRange.start), 'dd/mm/yyyy');
  info('Comparação: fim do mês anterior', excelCivilDate(comparisonRange.end), 'dd/mm/yyyy');
  info('Critério do comparativo', 'Mesmos dias do mês anterior, limitados ao último dia quando necessário; mês inteiro compara com mês inteiro. Mantém os filtros de status, macro, filial e pesquisa. Usa a posição atual dos títulos, não snapshots históricos.');
  info('Filtro: vencimento inicial', options.filters.start ? excelCivilDate(options.filters.start) : 'Sem restrição adicional', options.filters.start ? 'dd/mm/yyyy' : undefined);
  info('Filtro: vencimento final', options.filters.end ? excelCivilDate(options.filters.end) : 'Sem restrição adicional', options.filters.end ? 'dd/mm/yyyy' : undefined);
  info('Filtro: status', options.filters.status ? statusLabels[options.filters.status as PayableTitle['status']] ?? options.filters.status : 'Todos, incluindo histórico');
  info('Filtro: situação financeira', options.filters.financialStatus ? financialStatusLabels[options.filters.financialStatus as keyof typeof financialStatusLabels] ?? options.filters.financialStatus : 'Todas');
  info('Filtro: conferência', options.filters.reviewStatus === 'CONCILIADO' ? 'Conciliado' : options.filters.reviewStatus === 'A_CONCILIAR' ? 'A conciliar' : options.filters.reviewStatus || 'Todas');
  info('Filtro: macro', options.filters.macro || 'Todos');
  info('Filtro: filial', options.filters.branch || 'Todas');
  info('Filtro: pesquisa', options.filters.search || 'Sem pesquisa');
  info('Última importação da posição', options.importId ?? 'Nenhuma importação');
  info('Gerado em — America/Sao_Paulo', generated, 'dd/mm/yyyy hh:mm');
  info('Semana financeira', 'Sábado a sexta-feira');
  info('Quantidade de lançamentos', current.total.count);
  info('Quantidade em aberto', current.total.openCount);
  info('Quantidade quitada por importação', current.total.settledCount);
  info('Total dos lançamentos', checkedCents(current.total.total), CURRENCY);
  info('Total em aberto', checkedCents(current.total.open), CURRENCY);
  info('Total quitado por importação', checkedCents(current.total.settled), CURRENCY);
  info('Quantidade no mês anterior', prior.total.count);
  info('Total do mês anterior', checkedCents(prior.total.total), CURRENCY);
  info('Origem dos lançamentos', 'IMPORTAÇÃO DIÁRIA — relatório completo; quitado por importação não comprova compensação bancária.');
  info('Significado da data de baixa automática', SETTLEMENT_NOTE);
  if (payments) {
    info('Critério do valor em aberto', 'Saldo financeiro pendente de cada título quando informado pelo banco de dados. O status da importação permanece separado do status financeiro.');
    if (current.total.legacyOpenCount) info('Saldos sem conciliação disponível', `${current.total.legacyOpenCount} registro(s) sem saldo financeiro informado usam a classificação da importação no total em aberto; suas colunas financeiras permanecem indisponíveis, sem presumir pagamentos.`);
    info('Valor pago histórico dos títulos selecionados', current.total.unknownPaidCount ? UNKNOWN_FINANCIAL : checkedCents(current.total.paid), CURRENCY);
    info('Crédito por pagamentos excedentes', current.total.unknownOverpaidCount ? UNKNOWN_FINANCIAL : checkedCents(current.total.overpaid), CURRENCY);
    info('Realizado: quantidade de pagamentos', payments.count);
    info('Realizado: total pago no período', checkedCents(payments.total), CURRENCY);
    info('Critério do realizado', 'Data real de pagamento (paid_on), independente do vencimento do título. Somente pagamentos ativos; histórico de pagamentos anteriores preservado; novos registros exigem quitação integral. Mantém macro, filial e pesquisa; filtros de status da importação, situação financeira e conferência, quando preenchidos, também restringem os pagamentos pela situação atual dos respectivos títulos.');
    info('Macro do realizado', 'Classificação efetiva de eventual correção auditada (effective_macro); sem correção, usa a classificação original do pagamento (macro_snapshot). A classificação original permanece no detalhe e não acompanha mudanças da importação.');
    info('Valor nominal e valor realizado', 'Total dos lançamentos representa valores nominais dos registros preservados. Valor pago histórico reúne todos os pagamentos ativos dos títulos selecionados, inclusive de outros períodos. O realizado reúne somente pagamentos com data real no período selecionado e pode incluir títulos vencendo em outros meses.');
  }
  const relatedGroupCount = [...relatedEntries.values()].filter(count => count > 1).length;
  if (relatedGroupCount) info('Atenção: possíveis versões ou parcelas', `${relatedGroupCount} grupo(s) com a mesma filial e número de lançamento possuem mais de um registro no período selecionado. Possíveis versões ou parcelas do mesmo lançamento: confira os registros antes de interpretar os totais. Todos foram preservados, sem deduplicação automática; os totais representam registros preservados, não comprovam pagamento.`);
  lines.getCell('N1').note = SETTLEMENT_NOTE;
  lines.getCell('K1').note = 'Quitado por importação significa ausência no relatório completo importado; não comprova pagamento.';

  if (payments) {
    const actual = book.addWorksheet('Pagamentos realizados');
    actual.columns = ['ID do pagamento', 'ID do título', 'Nº Lançamento', 'Histórico/Favorecido', 'Filial', 'Centro de Custo Macro na baixa', 'Data real do pagamento', 'Banco/Conta do pagamento', 'Valor pago', 'Registrado em', 'Autor — identificação', 'Macro efetivo — classificação auditada'].map((header, index) => ({ header, width: [39, 39, 20, 48, 25, 34, 25, 34, 23, 25, 39, 40][index] }));
    const orderedPayments = [...options.payments!].sort((a, b) => a.paid_on < b.paid_on ? -1 : a.paid_on > b.paid_on ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const payment of orderedPayments) {
      const row = actual.addRow([payment.id, payment.title_id, payment.entry_number, payment.description, payment.branch, payment.macro_snapshot, excelCivilDate(payment.paid_on), payment.bank_label, checkedCents(BigInt(payment.amount_cents)), excelSaoPauloTime(payment.created_at), payment.created_by, payment.effective_macro ?? payment.macro_snapshot]);
      row.getCell(7).numFmt = 'dd/mm/yyyy'; row.getCell(9).numFmt = CURRENCY; row.getCell(10).numFmt = 'dd/mm/yyyy hh:mm';
    }
    actual.getCell('F1').note = 'Macro preservado no registro do pagamento; não substituído pela classificação atual do título.';
    actual.getCell('G1').note = 'Data real de pagamento; não é o vencimento nem a data de baixa por importação.';
    actual.getCell('L1').note = 'Classificação efetiva da correção auditada quando existe; sem correção, mantém o macro original da baixa.';
    const realized = book.addWorksheet('Realizado por Macro');
    realized.columns = [{ header: 'Centro de Custo Macro efetivo', width: 36 }, { header: 'Quantidade de pagamentos', width: 30 }, { header: 'Total pago no período', width: 26 }, { header: 'Participação no realizado', width: 30 }];
    for (const name of [...payments.macros.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
      const group = payments.macros.get(name)!;
      const row = realized.addRow([name, group.count, checkedCents(group.total), payments.total === 0n ? '—' : Number(group.total) / Number(payments.total)]);
      row.getCell(3).numFmt = CURRENCY; row.getCell(4).numFmt = PERCENTAGE;
    }
    const row = realized.addRow(['TOTAL', payments.count, checkedCents(payments.total), payments.total === 0n ? '—' : 1]);
    row.getCell(3).numFmt = CURRENCY; row.getCell(4).numFmt = PERCENTAGE; row.font = { bold: true };
  }

  for (const worksheet of book.worksheets) {
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF135B45' } };
    worksheet.getRow(1).alignment = { vertical: 'middle', wrapText: true };
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    worksheet.autoFilter = { from: 'A1', to: { row: 1, column: worksheet.columnCount } };
    worksheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    worksheet.headerFooter.oddFooter = `&L${SETTLEMENT_NOTE}`;
  }
  summary.getColumn(2).alignment = { wrapText: true };
  return book;
}
