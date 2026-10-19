import type { CommercialRow } from './commercial';
import type { ImportProblem } from './payables';
export function validateCommercialRows(matrix: unknown[][],options?:{excel1904?:boolean}):{rows:Omit<CommercialRow,'id'|'import_id'|'margin_percent'>[];errors:ImportProblem[]};
