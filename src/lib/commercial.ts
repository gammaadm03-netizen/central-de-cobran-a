import { publishableKey, supabase, supabaseUrl } from './supabase';
import type { ImportProblem } from './payables';
export interface CommercialRow { id:string; import_id:string; line_number:number; code:string; product:string; client:string; employee:string; invoice:string; cost_center:string; branch:string; issued_on:string; quantity:number|null; sale_cents:number; freight_cents:number|null; tax_cents:number|null; cost_cents:number|null; commission_cents:number|null; margin_cents:number|null; margin_percent:number|null; margin_source:'PROVIDED'|'CALCULATED'|'UNAVAILABLE' }
export interface CommercialFilters { month:string; search:string; branch:string; centre:string; employee:string; marginBand:string }
export interface CommercialReport { month:string; count:number; rows:CommercialRow[]; revision:string; source:{import_id:string;file_name:string;updated_at:string;month:string}|null; options:{months:string[];branches:string[];centres:string[];employees:string[]}; summary:{sale_cents:number; margin_cents:number|null; margin_percent:number|null; row_count:number; margin_missing_count:number|null; filtered_sale_cents:number; filtered_margin_cents:number|null; filtered_margin_percent:number|null; filtered_count:number; filtered_margin_missing_count:number|null} }
export type BusinessImportBody = { action:'preview'|'commit'; mode:'commercial'|'hr'; file_name:string; file_base64:string; month?:string; reference_date?:string; previous_import_id?:string|null; complete?:boolean } | import('./product-costs').CostImportBody | import('./product-costs').CostRecalculationBody;
export function commercialError(error:unknown,fallback:string) {
  const code=error && typeof error==='object' && 'code' in error ? String(error.code) : '';
  if(code==='42501')return 'Seu perfil não tem permissão para esta operação.';
  if(['PGRST301','PGRST303'].includes(code))return 'Sua sessão expirou. Entre novamente.';
  if(code==='40001')return 'A base mudou desde a análise. Analise o relatório novamente antes de concluir.';
  if(['PGRST202','PGRST205','42P01','42883','P0032'].includes(code))return 'A atualização do banco de RH/DP e Faturamento ainda não está disponível. Execute o SQL de ativação e tente novamente.';
  if(['22023','22007','23514'].includes(code))return 'Confira o mês de referência, os cabeçalhos e os valores do relatório.';
  return fallback;
}
export async function readCommercial(filters:CommercialFilters,offset=0,limit=25,signal?:AbortSignal):Promise<CommercialReport> {
  if(!supabase)throw {code:'PGRST301'};
  let query=supabase.rpc('list_commercial_items',{p_month:filters.month||null,p_search:filters.search,p_branch:filters.branch,p_centre:filters.centre,p_employee:filters.employee,p_margin_band:filters.marginBand,p_offset:offset,p_limit:limit});
  if(signal)query=query.abortSignal(signal);const {data,error}=await query;if(error)throw error;
  if(!data || !Array.isArray(data.rows) || !Number.isSafeInteger(data.count) || typeof data.revision!=='string')throw new Error('Resposta do fechamento inválida.');
  // A sales-only profile can receive rows with confidential costs omitted.
  // Keep missing optional financial data unknown; mandatory sale/identity fields
  // are deliberately left untouched for the consumer's response validation.
  const optionalFinancialFields = ['freight_cents','tax_cents','cost_cents','commission_cents','margin_cents','margin_percent'] as const;
  const rows = data.rows.map((row:unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const normalized:Record<string,unknown> = { ...row };
    for (const key of optionalFinancialFields) if (!Object.hasOwn(row,key)) normalized[key] = null;
    if (!Object.hasOwn(row,'margin_source')) normalized.margin_source = 'UNAVAILABLE';
    return normalized;
  });
  return { ...data, rows } as CommercialReport;
}
export async function commercialImportRequest<T>(body:BusinessImportBody,signal?:AbortSignal):Promise<T> {
  if(!supabase)throw {code:'PGRST301'};
  const {data:{session}}=await supabase.auth.getSession();if(!session?.access_token)throw {code:'PGRST301'};
  const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();const timeout=window.setTimeout(cancel,30000);
  try{
    const response=await fetch(`${supabaseUrl}/functions/v1/business-import`,{method:'POST',headers:{apikey:publishableKey,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal,credentials:'omit',cache:'no-store'});
    const result=await response.json();
    if(!response.ok){const errors:ImportProblem[]=Array.isArray(result?.errors)?result.errors.slice(0,100).filter((row:ImportProblem)=>Number.isSafeInteger(row?.line)&&typeof row.column==='string'&&typeof row.problem==='string'&&typeof row.correction==='string'):[];
      throw {code:typeof result?.code==='string'?result.code:response.status===401?'PGRST301':response.status===403?'42501':'',errors};}
    return result as T;
  }finally{window.clearTimeout(timeout);signal?.removeEventListener('abort',cancel);}
}
