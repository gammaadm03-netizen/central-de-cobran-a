import { isUuid } from './commissions.ts';

export interface PendingCollectionCommission {
  event_id: string; title_id: string; document: string; client_name: string; branch: string;
  due_date: string; nominal_reference_cents: number; collector_id: string | null; collector_name: string | null;
  retired_at: string; reference_date: string; source_import_id: string;
  status: 'AWAITING_RECEIVED_REPORT'; payment_date: null; commission_cents: null;
}
export interface PendingCollectionCommissionsReport {
  format_version: 'pending-collection-commissions-v1'; count: number; revision: string;
  rows: PendingCollectionCommission[]; options: { collectors: { id: string; display_name: string }[] };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 1500): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function isPendingCollectionCommissionsReport(value: unknown): value is PendingCollectionCommissionsReport {
  if (!object(value) || value.format_version !== 'pending-collection-commissions-v1' || !count(value.count) || !text(value.revision, 200)
    || !Array.isArray(value.rows) || value.rows.length > 25 || value.rows.length > value.count || !object(value.options) || !Array.isArray(value.options.collectors) || value.options.collectors.length > 1000) return false;
  return value.rows.every(row => object(row) && isUuid(row.event_id) && isUuid(row.title_id) && text(row.document, 150) && text(row.client_name) && text(row.branch, 500)
    && date(row.due_date) && count(row.nominal_reference_cents) && (row.collector_id === null || isUuid(row.collector_id)) && (row.collector_name === null || text(row.collector_name, 500))
    && timestamp(row.retired_at) && date(row.reference_date) && isUuid(row.source_import_id) && row.status === 'AWAITING_RECEIVED_REPORT' && row.payment_date === null && row.commission_cents === null)
    && new Set(value.rows.map(row => row.event_id)).size === value.rows.length && new Set(value.rows.map(row => row.title_id)).size === value.rows.length
    && value.options.collectors.every(collector => object(collector) && isUuid(collector.id) && text(collector.display_name, 500))
    && new Set(value.options.collectors.map(collector => collector.id)).size === value.options.collectors.length;
}
export function pendingCollectionCommissionsError(error: unknown): string {
  const code = object(error) ? String(error.code ?? '') : '';
  if (['PGRST202', '42883', '42P01', 'P0047'].includes(code)) return 'A fila de pendências precisa da atualização 047 do banco. Solicite a ativação à administração. A apuração dos recebimentos confirmados continua disponível.';
  if (code === '42501') return 'Seu acesso não permite consultar estas pendências. Entre novamente ou consulte a administração.';
  return 'Não foi possível consultar os títulos aguardando recebimento. Atualize as pendências e tente novamente.';
}
