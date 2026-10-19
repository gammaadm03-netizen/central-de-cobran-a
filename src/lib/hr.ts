import type { HrImportRow } from './hr-parser.mjs';
export interface HrRow extends HrImportRow { basket_eligible:boolean;basket_cost_cents:number;is_partner:boolean }
export interface HrSummary { employees:number;partners:number;admissions:number;birthdays:number;basket_eligible:number;basket_excluded:number;basket_unit_cents:number;basket_monthly_cents:number;basket_annual_cents:number;salary_base_cents:number|null;payroll_salary_cents:number|null;transport_cents:number|null;advance_cents:number|null;cost_allowance_cents:number|null;total_cents:number|null }
export interface HrQuality { missing_admission:number;missing_birthday:number;missing_branch:number;missing_sector:number;missing_salary_base:number;missing_payroll_salary:number;missing_transport:number;missing_advance:number;missing_cost_allowance:number;missing_total:number }
export interface HrGroup { label:string;count:number;salary_base_cents:number|null }
export interface HrReport { calendar_month:string;snapshot:{id:string;reference_date:string;file_name:string;imported_at:string;sha256:string;row_count:number;format_version?:number}|null;summary:HrSummary;quality:HrQuality;by_branch:HrGroup[];by_sector:HrGroup[];birthdays:(HrRow&{day:number})[];work_anniversaries:(HrRow&{day:number;years:number})[];rows:HrRow[] }
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value);
const nullableMoney=(value:unknown)=>value===null||integer(value);
export function isHrReport(value:unknown):value is HrReport {
  if(!value||typeof value!=='object')return false;
  const report=value as HrReport;
  if(typeof report.calendar_month!=='string'||!/^\d{4}-\d{2}-01$/.test(report.calendar_month)||!report.summary||!report.quality)return false;
  if(report.snapshot!==null&&(!report.snapshot||typeof report.snapshot.id!=='string'||typeof report.snapshot.file_name!=='string'||typeof report.snapshot.imported_at!=='string'||typeof report.snapshot.reference_date!=='string'||typeof report.snapshot.sha256!=='string'||!integer(report.snapshot.row_count)))return false;
  if(!['employees','partners','admissions','birthdays','basket_eligible','basket_excluded','basket_unit_cents','basket_monthly_cents','basket_annual_cents'].every(key=>integer(report.summary[key as keyof HrSummary])))return false;
  if(!['salary_base_cents','transport_cents','advance_cents','total_cents'].every(key=>nullableMoney(report.summary[key as keyof HrSummary])))return false;
  if(!['payroll_salary_cents','cost_allowance_cents'].every(key=>!Object.hasOwn(report.summary,key)||nullableMoney(report.summary[key as keyof HrSummary])))return false;
  if(!['missing_admission','missing_birthday','missing_branch','missing_sector','missing_salary_base','missing_payroll_salary','missing_transport','missing_advance','missing_total'].every(key=>integer(report.quality[key as keyof HrQuality])))return false;
  if(Object.hasOwn(report.quality,'missing_cost_allowance')&&!integer(report.quality.missing_cost_allowance))return false;
  const row=(entry:HrRow)=>entry&&integer(entry.source_row)&&['branch','employee','sector'].every(key=>typeof entry[key as keyof HrRow]==='string')&&['admitted_on','birthday_on'].every(key=>entry[key as keyof HrRow]===null||typeof entry[key as keyof HrRow]==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(String(entry[key as keyof HrRow])))&&(entry.count_label===null||typeof entry.count_label==='string')&&['salary_base_cents','payroll_salary_cents','transport_cents','advance_cents','total_cents'].every(key=>nullableMoney(entry[key as keyof HrRow]))&&typeof entry.basket_eligible==='boolean'&&typeof entry.is_partner==='boolean'&&integer(entry.basket_cost_cents);
  const validRow=(entry:HrRow)=>row(entry)&&(!Object.hasOwn(entry,'cost_allowance_cents')||nullableMoney(entry.cost_allowance_cents));
  return Array.isArray(report.rows)&&report.rows.every(validRow)&&Array.isArray(report.birthdays)&&report.birthdays.every(entry=>validRow(entry)&&integer(entry.day))&&Array.isArray(report.work_anniversaries)&&report.work_anniversaries.every(entry=>validRow(entry)&&integer(entry.day)&&integer(entry.years))&&[report.by_branch,report.by_sector].every(group=>Array.isArray(group)&&group.every(entry=>typeof entry.label==='string'&&integer(entry.count)&&nullableMoney(entry.salary_base_cents)));
}
