import type { ImportProblem } from './payables';
import type { ReceivableCollectorHint } from './receivables-parser.mjs';
export interface CollectorPlanAssignment { customer_key: string; collector_id: string | null; requires_selection: boolean; locked: boolean }
export interface CollectorPlanAgent { id: string; display_name: string; enabled: boolean }
export interface CollectorHintSummary { file_title_count: number; file_customer_count: number; assigned_customer_count: number; preserved_customer_count: number; manual_customer_count: number }
export function resolveReceivableCollectorHints(input: {
  hints: ReceivableCollectorHint[];
  assignments: CollectorPlanAssignment[];
  collectors: CollectorPlanAgent[];
  mappings?: Record<string, string>;
}): { mappings: Record<string, string>; problems: ImportProblem[]; summary: CollectorHintSummary };
