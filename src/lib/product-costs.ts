import { supabase } from './supabase';
import { commercialImportRequest } from './commercial';

export interface ProductCostRow { line_number: number; code: string; product: string; weight_kg: string | null; unit_cost: string | null; source_lines?: number[] }
export interface CostConflict { code: string; product: string; options: { line_number: number; unit_cost: string | null; weight_kg: string | null }[] }
export interface CostSource { import_id: string; reference_date: string; file_name: string; created_at: string }
export interface CostPreview { format_version: 'costs-v1'; row_count: number; item_count: number; reference_date: string; previous_import_id: string | null; new_count: number; changed_count: number; unchanged_count: number; zero_cost_count: number; missing_cost_count: number; missing_weight_count: number; conflicts: CostConflict[]; can_commit: boolean }
export interface CostAnalysis { format_version: 'costs-v1'; file_sha256: string; rows: ProductCostRow[]; preview: CostPreview }
export interface CostReport { rows: ProductCostRow[]; count: number; revision: string; source: CostSource | null; quality?: Record<string, number>; options?: { reference_dates: string[] } }
export interface CostImportBody { action: 'preview' | 'commit'; mode: 'costs'; reference_date: string; file_name: string; file_base64: string; resolutions: Record<string, number>; previous_import_id?: string | null; complete?: boolean }
export interface CostRecalculationRow { id: string; line_number: number; code: string; product: string; invoice: string; branch: string; quantity: string | null; unit_cost: string | null; previous_cost_cents: number | null; new_cost_cents: number | null; previous_margin_cents: number | null; new_margin_cents: number | null; error_codes: string[] }
export interface CostRecalculation { format_version: 'costs-recalculation-v1'; month: string; cost_import_id: string; previous_import_id: string | null; source: { import_id: string; month: string; file_name: string } | null; cost_source: CostSource; row_count: number; matched_count: number; missing_code_count: number; missing_quantity_count: number; invalid_quantity_count: number; missing_cost_count: number; zero_cost_count: number; missing_components_count: number; can_apply: boolean; already_applied?: boolean; totals: { previous_cost_cents: number | null; new_cost_cents: number | null; previous_margin_cents: number | null; new_margin_cents: number | null }; rows: CostRecalculationRow[] }
export interface CostRecalculationBody { action: 'preview' | 'commit'; mode: 'costs_recalculation'; cost_import_id: string; month: string; previous_import_id?: string | null; request_id?: string; complete?: boolean }
export const costUuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
export const costDecimal = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value);
export const costQuantity = (value: unknown): value is string => typeof value === 'string' && /^-?(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(value);
function displayDecimal(value: string, minimumFraction: number) {
  const [integer, rawFraction = ''] = value.split('.'), fraction = rawFraction.replace(/0+$/, '').padEnd(minimumFraction, '0');
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${fraction ? `,${fraction}` : ''}`;
}
export const displayUnitCost = (value: string | null) => value === null ? 'Não informado' : `R$ ${displayDecimal(value, 2)}`;
export const displayWeight = (value: string | null) => value === null ? 'Não informado' : displayDecimal(value, 0);
export function productCostError(error: unknown, fallback: string) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['P0044', 'P0045', 'PGRST202', 'PGRST205', '42P01', '42883'].includes(code)) return 'Ative a atualização de Custos no banco e na função business-import. Depois, analise novamente.';
  if (code === '42501') return 'Seu perfil não tem permissão para esta operação.';
  if (['PGRST301', 'PGRST303'].includes(code)) return 'Sua sessão expirou. Entre novamente.';
  if (code === '40001') return 'A base mudou desde a análise. Confira novamente antes de confirmar.';
  if (['22023', '22007', '22003', '23514'].includes(code)) return 'Confira a referência, os custos, as escolhas dos códigos repetidos e os itens apontados na análise.';
  return fallback;
}
export function productCostRequest<T>(body: CostImportBody | CostRecalculationBody, signal?: AbortSignal) { return commercialImportRequest<T>(body, signal); }
export async function readProductCosts(importId: string | null, search: string, offset: number, signal?: AbortSignal): Promise<CostReport> {
  if (!supabase) throw { code: 'PGRST301' };
  let query = supabase.rpc('list_product_costs', { p_import_id: importId, p_search: search, p_offset: offset, p_limit: 25 });
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query; if (error) throw error; return data as CostReport;
}
export async function readCostHistory(signal?: AbortSignal): Promise<{ rows: (CostSource & { id: string; row_count: number; item_count: number })[]; count: number }> {
  if (!supabase) throw { code: 'PGRST301' };
  let query = supabase.rpc('list_product_cost_imports', { p_offset: 0, p_limit: 50 }); if (signal) query = query.abortSignal(signal);
  const { data, error } = await query; if (error) throw error; return data;
}
