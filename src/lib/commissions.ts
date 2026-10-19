export type CommissionKind = 'COLLECTOR' | 'SELLER';
export const collectorBands = { ATE_30: '1–30 dias', '31_60': '31–60 dias', '61_90': '61–90 dias', '91_180': '91–180 dias', '181_365': '181–365 dias', ACIMA_365: '>365 dias' };
export const sellerBands = { LT10: 'Abaixo de 10%', '10_15': '10% a 15%', '15_20': 'Acima de 15% a 20%', '20_25': 'Acima de 20% a 25%', '25_30': 'Acima de 25% a 30%', '30_35': 'Acima de 30% a 35%', GT35: 'Acima de 35%' };
export const commissionEligibility = {
  ASSESSED: 'Comissão apurada', NO_COMMISSION: 'Sem comissão na faixa', NOT_ELIGIBLE: 'Fora da apuração',
  PENDING_OWNER: 'Responsável pendente', PENDING_RULE: 'Regra / vigência pendente', RATE_BOUNDARY: 'Conferir limite de faixa',
  INVALID_SALE: 'Conferir venda / devolução', MISSING_COSTS: 'Custos do fechamento incompletos',
};
export type CommissionEligibility = keyof typeof commissionEligibility;
export type SellerPolicy = 'COMMERCIAL' | 'LARGE_ACCOUNTS' | 'MATEUS' | 'KEVYN' | 'FRANCISCO' | 'NONE';
export const sellerPolicyLabels: Record<SellerPolicy, string> = {
  COMMERCIAL: 'Comercial', LARGE_ACCOUNTS: 'Grandes Contas', MATEUS: 'Mateus / Grandes Contas e COMLURB',
  KEVYN: 'Kevyn', FRANCISCO: 'Francisco / Centro de custo', NONE: 'Sem comissão',
};
export interface CommissionRow {
  id: string; source_revision: string; date: string; document: string; client_name: string; branch: string;
  subject: string | null; subject_name: string; amount_cents: number; commission_cents: number | null;
  rule_config?: Record<string, unknown> | null; rule_id: string | null; rule_effective_from: string | null; eligibility: CommissionEligibility; band: string | null;
  title_id?: string; due_date?: string; nominal_amount_cents?: number; delay_days?: number;
  product?: string; cost_center?: string; policy?: SellerPolicy | null; margin_cents?: number | null; margin_bps?: number | null;
  cost_cents?: number | null; freight_cents?: number | null; tax_cents?: number | null; rate_bps?: number | null;
  rate_numerator?: number; rate_denominator?: number;
}
export interface CommissionSummary { subject: string | null; subject_name: string; count: number; amount_cents: number; commission_cents: number | null; margin_cents: number | null; pending_count: number }
export interface CommissionRule { id: string; kind: CommissionKind; subject: string; effective_from: string; created_at: string; reason: string; config: { eligible_collector_ids?: string[]; bands?: CollectorBand[]; policy?: SellerPolicy; minimum_margin_bps?: number } }
export interface CollectorBand { band: string; label: string; reference_cents: number; commission_reference_cents: number }
export interface CommissionAssessment { id: string; kind: CommissionKind; period_start: string; period_end: string; subject: string | null; band: string | null; revision: string; created_at: string }
export interface CommissionReport {
  kind: CommissionKind; start: string; end: string; subject: string | null; band: string | null;
  rows: CommissionRow[]; count: number; total_amount_cents: number; eligible_amount_cents: number; commission_cents: number;
  margin_cents: number; pending_count: number; assessed_count: number; average_delay_days: number; complete: boolean;
  summaries: CommissionSummary[]; bands: { band: string | null; count: number; amount_cents: number; commission_cents: number | null; pending_count: number }[];
  options: { id: string; name: string; enabled: boolean }[]; rule_versions: CommissionRule[];
  collector_bands: CollectorBand[]; revision: string; assessments?: CommissionAssessment[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const text = (v: unknown, max = 1000): v is string => typeof v === 'string' && v.length <= max;
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const cents = (v: unknown): v is number => Number.isSafeInteger(v);
const count = (v: unknown): v is number => cents(v) && v >= 0;
const nullableCents = (v: unknown) => v === null || cents(v);
const nullableText = (v: unknown) => v === null || text(v);
const array = (v: unknown, check: (v: any) => boolean, max = 5000): boolean => Array.isArray(v) && v.length <= max && v.every(check);
export function isCommissionReport(v: unknown): v is CommissionReport {
  if (!object(v) || !['COLLECTOR', 'SELLER'].includes(String(v.kind))) return false;
  const collector = v.kind === 'COLLECTOR';
  return date(v.start) && date(v.end) && String(v.start) <= String(v.end) && nullableText(v.subject) && nullableText(v.band)
    && ['count', 'pending_count', 'assessed_count'].every(k => count(v[k]))
    && ['total_amount_cents', 'eligible_amount_cents', 'commission_cents', 'margin_cents'].every(k => cents(v[k]))
    && Number(v.pending_count) <= Number(v.count) && typeof v.complete === 'boolean' && v.complete === (v.pending_count === 0)
    && typeof v.average_delay_days === 'number' && Number.isFinite(v.average_delay_days) && v.average_delay_days >= 0
    && typeof v.revision === 'string' && /^[a-f0-9]{32}$/.test(v.revision)
    && Array.isArray(v.rows) && v.rows.length <= Number(v.count) && array(v.rows, r => object(r) && text(r.id) && text(r.source_revision) && date(r.date) && text(r.document) && text(r.client_name, 1500) && text(r.branch)
      && nullableText(r.subject) && text(r.subject_name) && cents(r.amount_cents) && nullableCents(r.commission_cents)
      && Object.hasOwn(commissionEligibility, String(r.eligibility)) && nullableText(r.band) && (r.rule_id === null || isUuid(r.rule_id))
      && (r.rule_effective_from === null || date(r.rule_effective_from))
      && (collector ? isUuid(r.id) && isUuid(r.title_id) && date(r.due_date) && count(r.nominal_amount_cents) && count(r.delay_days) && count(r.rate_numerator) && count(r.rate_denominator)
        : text(r.product) && text(r.cost_center) && nullableCents(r.margin_cents) && nullableCents(r.cost_cents) && nullableCents(r.freight_cents) && nullableCents(r.tax_cents)
        && (r.margin_bps === null || typeof r.margin_bps === 'number' && Number.isFinite(r.margin_bps)) && nullableCents(r.rate_bps)), 50000)
    && array(v.summaries, r => object(r) && nullableText(r.subject) && text(r.subject_name) && count(r.count) && cents(r.amount_cents) && nullableCents(r.commission_cents) && nullableCents(r.margin_cents) && count(r.pending_count))
    && array(v.bands, r => object(r) && nullableText(r.band) && count(r.count) && cents(r.amount_cents) && nullableCents(r.commission_cents) && count(r.pending_count), 20)
    && array(v.options, r => object(r) && text(r.id, 500) && text(r.name, 500) && typeof r.enabled === 'boolean', collector ? 1000 : 5000)
    && array(v.rule_versions, r => object(r) && isUuid(r.id) && ['COLLECTOR', 'SELLER'].includes(String(r.kind)) && text(r.subject, 500) && date(r.effective_from) && text(r.created_at) && text(r.reason, 2000) && object(r.config)
      && (r.kind === 'COLLECTOR' ? array(r.config.eligible_collector_ids, isUuid, 1000) : Object.hasOwn(sellerPolicyLabels, String(r.config.policy)) && count(r.config.minimum_margin_bps)), 1000)
    && array(v.collector_bands, r => object(r) && text(r.band) && text(r.label) && count(r.reference_cents) && count(r.commission_reference_cents), 6)
    && (v.assessments === undefined || array(v.assessments, r => object(r) && isUuid(r.id) && ['COLLECTOR', 'SELLER'].includes(String(r.kind)) && date(r.period_start) && date(r.period_end) && nullableText(r.subject) && nullableText(r.band) && text(r.created_at) && text(r.revision), 50));
}
export function commissionError(error: unknown, writing = false): string {
  const code = object(error) ? String(error.code ?? '') : '';
  if (['PGRST202', '42883', '42P01'].includes(code)) return 'A apuração de comissões precisa da atualização do banco. Solicite a ativação à administração.';
  if (code === '42501') return 'Seu acesso não permite esta operação de comissões. Entre novamente ou consulte a administração.';
  if (code === '40001') return 'A base ou a regra mudou. Atualize a consulta antes de salvar.';
  if (code === '22023') return 'Confira os filtros, a vigência e as regras pendentes antes de continuar.';
  return writing ? 'Não foi possível salvar. Confira a conexão e tente novamente.' : 'Não foi possível consultar as comissões. Confira a conexão e tente novamente.';
}
export function percentToBps(value: string): number {
  const cleaned = value.trim().replace(',', '.');
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(cleaned)) throw new Error('Informe a margem em percentual, com até duas casas decimais.');
  const [whole, decimals = ''] = cleaned.split('.');
  const bps = Number(BigInt(whole) * 100n + BigInt(decimals.padEnd(2, '0')));
  if (bps > 10000) throw new Error('A margem mínima deve estar entre 0% e 100%.');
  return bps;
}
export function formatCommissionRate(row: CommissionRow): string {
  const rate = row.rate_bps !== undefined ? row.rate_bps === null ? null : row.rate_bps / 100
    : row.rate_denominator ? (row.rate_numerator ?? 0) / row.rate_denominator * 100 : 0;
  return rate === null ? 'Pendente' : `${rate.toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%`;
}
/** Currency stays text in the exported workbook, preserving every cent and blocking spreadsheet formulas. */
function exactMoney(value: number | null | undefined): string {
  if (value === undefined || value === null) return 'Pendente';
  if (!Number.isSafeInteger(value)) throw new Error('Valor fora do limite de precisão.');
  const cents = BigInt(value), abs = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${abs / 100n},${String(abs % 100n).padStart(2, '0')}`;
}
export async function commissionWorkbook(report: CommissionReport) {
  if (!isCommissionReport(report) || report.rows.length !== report.count) throw new Error('A exportação exige todas as linhas da mesma revisão.');
  const { default: ExcelJS } = await import('exceljs'), book = new ExcelJS.Workbook();
  book.creator = 'Central Financeira · Grupo Ecoplast';
  const summary = book.addWorksheet('Resumo');
  summary.addRows([['Comissões', report.kind === 'COLLECTOR' ? 'Cobradoras' : 'Vendedores'], ['Período inicial', report.start], ['Período final', report.end],
    ['Revisão da base', report.revision], ['Total da base (R$)', exactMoney(report.total_amount_cents)], ['Comissão apurada (R$)', exactMoney(report.commission_cents)],
    ['Itens pendentes', report.pending_count], ['Natureza', 'Apuração de comissão; não representa pagamento']]);
  const sheet = book.addWorksheet('Detalhamento');
  sheet.addRow(['Data', 'Responsável', 'Cliente', 'Documento / NF', 'Filial', 'Produto / vencimento', 'Centro de custo / dias de atraso', 'Base efetiva (R$)', 'Taxa', 'Comissão (R$)', 'Margem calculada (R$)', 'Situação', 'Versão da regra', 'Vigência', 'Origem', 'Revisão da origem', 'Configuração da regra aplicada']);
  for (const r of report.rows) sheet.addRow([r.date, r.subject_name, r.client_name, r.document, r.branch, r.product ?? r.due_date ?? '', r.cost_center ?? r.delay_days ?? '', exactMoney(r.amount_cents),
    formatCommissionRate(r), exactMoney(r.commission_cents), report.kind === 'SELLER' ? exactMoney(r.margin_cents) : '', commissionEligibility[r.eligibility], r.rule_id ?? 'Pendente', r.rule_effective_from ?? '', r.id, r.source_revision, r.rule_config ? JSON.stringify(r.rule_config) : 'Pendente']);
  for (const s of [summary, sheet]) { s.views = [{ state: 'frozen', ySplit: 1 }]; s.columns.forEach(c => { c.width = 25; }); s.getRow(1).font = { bold: true }; }
  return book;
}
