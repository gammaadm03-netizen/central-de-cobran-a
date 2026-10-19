export interface HrImportRow { source_row:number;branch:string;employee:string;sector:string;admitted_on:string|null;birthday_on:string|null;salary_base_cents:number|null;payroll_salary_cents:number|null;transport_cents:number|null;advance_cents:number|null;cost_allowance_cents:number|null;total_cents:number|null;count_label:string|null }
export interface HrImportProblem { line:number;column:string;problem:string;correction:string }
export function validateHrRows(matrix:unknown[][],options?:{excel1904?:boolean}):{rows:HrImportRow[];errors:HrImportProblem[]};
export const parseHrRows:typeof validateHrRows;
