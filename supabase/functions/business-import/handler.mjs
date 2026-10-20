import { MAX_FILE_BYTES, MAX_ROWS, parseCsv, parseCivilDate, validateWorkbookExpandedSize } from '../../../src/lib/payables-parser.mjs';
import { validateCommercialRows } from '../../../src/lib/commercial-parser.mjs';
import { validateHrRows } from '../../../src/lib/hr-parser.mjs';
import { validateCostRows } from '../../../src/lib/costs-parser.mjs';
import { validCostPreview, validCostRecalculation, validCostResolutions } from './costs-contract.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const uuidValue=value=>typeof value==='string'&&UUID.test(value);
const FAILURE='Não foi possível confirmar a operação. Atualize o histórico antes de tentar novamente.';
const INVALID='Solicitação inválida. Selecione novamente o relatório completo.';
const CORRECTION='Confira os cabeçalhos e salve uma cópia somente com valores.';
const HR_CORRECTION='Confira os cabeçalhos e os totais. Se houver fórmulas financeiras, recalcule e salve o arquivo no Excel antes de importar.';
function origins(raw){const values=String(raw||'').split(',').map(value=>value.trim()).filter(Boolean);if(!values.length)throw Error('origins');return new Set(values.map(value=>{const url=new URL(value);if(url.origin!==value||!['https:','http:'].includes(url.protocol)||(url.protocol==='http:'&&!['localhost','127.0.0.1'].includes(url.hostname)))throw Error('origin');return value;}));}
async function bodyOf(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw Error('body');
 const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>3*1024*1024))throw Error('size');
 const reader=request.body?.getReader();if(!reader)throw Error('body');const parts=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>3*1024*1024){await reader.cancel();throw Error('size');}parts.push(part.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
 const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!body||typeof body!=='object'||Array.isArray(body))throw Error('body');return body;
}
function decode(encoded){if(typeof encoded!=='string'||!encoded.length||encoded.length>4*Math.ceil(MAX_FILE_BYTES/3)||encoded.length%4||/[^A-Za-z0-9+/=]/.test(encoded))throw Error('base64');const binary=atob(encoded);if(!binary.length||binary.length>MAX_FILE_BYTES||btoa(binary)!==encoded)throw Error('file');return Uint8Array.from(binary,c=>c.charCodeAt(0));}
function sessionId(token,id){const part=token.split('.')[1];if(!part)throw Error('claims');const claims=JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/')));if(claims.sub!==id||!UUID.test(claims.session_id??''))throw Error('claims');return claims.session_id;}
const problems=(errors,correction=CORRECTION)=>errors.slice(0,100).map(row=>({line:Number.isSafeInteger(row.line)&&row.line>=0&&row.line<=5021?row.line:0,column:String(row.column||'Arquivo').slice(0,100),problem:String(row.problem||'Linha inválida.').slice(0,400),correction:String(row.correction||correction).slice(0,400)}));

/** Original bytes are authenticated, bounded and parsed again on every preview/commit. */
export function createBusinessGateway({env,fetch:fetcher=globalThis.fetch,loadWorkbook,log=()=>{}}){return async request=>{
 let allowed;try{allowed=origins(env('ALLOWED_ORIGINS'));}catch{return new Response(JSON.stringify({error:FAILURE}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
 const origin=request.headers.get('origin');if(!origin||!allowed.has(origin))return new Response(JSON.stringify({error:'Origem não autorizada.'}),{status:403,headers:{'Content-Type':'application/json','Cache-Control':'no-store',Vary:'Origin'}});
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':origin,Vary:'Origin'};
 const respond=(status,value)=>new Response(JSON.stringify(value),{status,headers});
 if(request.method==='OPTIONS'){const requested=(request.headers.get('access-control-request-headers')||'').toLowerCase().split(',').map(v=>v.trim()).filter(Boolean);if(request.headers.get('access-control-request-method')!=='POST'||requested.some(v=>!['authorization','content-type','apikey','x-client-info'].includes(v)))return respond(403,{error:INVALID});return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'authorization, content-type, apikey, x-client-info','Access-Control-Max-Age':'600'}});}
 if(request.method!=='POST')return respond(405,{error:'Método não permitido.'});
 const token=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/i)?.[1];if(!token)return respond(401,{error:'Sua sessão expirou. Entre novamente.'});
 let base,serviceKey,anonKey;try{const url=new URL(env('SUPABASE_URL'));serviceKey=env('SUPABASE_SERVICE_ROLE_KEY');anonKey=env('SUPABASE_ANON_KEY');if(!serviceKey||!anonKey||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('config');base=url.origin;}catch{return respond(503,{error:FAILURE});}
 const signal=AbortSignal.any([request.signal,AbortSignal.timeout(25000)]);
 async function call(path,{method='POST',service=false,data}={}){const result=await fetcher(`${base}${path}`,{method,headers:{apikey:service?serviceKey:anonKey,Authorization:`Bearer ${service?serviceKey:token}`,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal});let payload=null;try{payload=await result.json();}catch{}return{ok:result.ok,status:result.status,payload};}
 let activationCode='P0032';
 function fail(result){const code=result.payload?.code;if(code==='42501')return respond(403,{code,error:'Seu perfil não tem permissão para esta operação.'});if(code==='40001')return respond(409,{code,error:'A base mudou. Analise o relatório novamente.'});if(['PGRST202','42P01','42883','P0044','P0045'].includes(code))return respond(409,{code:activationCode,error:'Ative a atualização do banco antes de importar.'});if(['22023','22007','22008','23514','22003','22P02'].includes(code))return respond(400,{code:'22023',error:'Confira a referência e as linhas do relatório.'});if(result.status===401)return respond(401,{error:'Sua sessão expirou. Entre novamente.'});log('upstream_unavailable');return respond(503,{error:FAILURE});}
 try{
  const auth=await call('/auth/v1/user',{method:'GET'});if(!auth.ok)return auth.status===401||auth.status===403?respond(401,{error:'Sua sessão expirou. Entre novamente.'}):fail(auth);
  if(!UUID.test(auth.payload?.id??''))throw Error('identity');let verifiedSession;try{verifiedSession=sessionId(token,auth.payload.id);}catch{return respond(401,{error:'Sua sessão expirou. Entre novamente.'});}
  const access=await call('/rest/v1/rpc/current_access',{data:{}});if(!access.ok)return fail(access);
  const permissions=access.payload?.permissions,has=(resource,action='read')=>Array.isArray(permissions)&&permissions.some(p=>p?.resource===resource&&p.action===action);
  if(access.payload?.profile?.id!==auth.payload.id||access.payload.profile.enabled!==true||!has('importar_bases')||!(has('fechamento','import')||has('rh_dp','import')||has('custos','import')))return respond(403,{code:'42501',error:'Seu perfil não tem permissão para esta operação.'});
  let body;try{body=await bodyOf(request);}catch{return respond(400,{error:INVALID});}
  if(!['preview','commit'].includes(body.action)||!['commercial','hr','costs','costs_recalculation'].includes(body.mode))return respond(400,{error:INVALID});
  const commercial=body.mode==='commercial',costs=body.mode==='costs',recalculation=body.mode==='costs_recalculation';
  if(!(commercial?has('fechamento','import')&&has('faturamento'):costs||recalculation?has('custos','import')&&has('margens')&&(!recalculation||has('fechamento','import')&&has('faturamento')):has('rh_dp','import')&&has('rh_dp')&&has('rh_dp','write')))return respond(403,{code:'42501',error:'Seu perfil não tem permissão para esta operação.'});
  activationCode=recalculation?'P0045':costs?'P0044':'P0032';
  if(recalculation){
   if(Object.keys(body).some(key=>!['action','mode','month','cost_import_id','previous_import_id','request_id','complete'].includes(key))||!uuidValue(body.cost_import_id)||typeof body.month!=='string'||!/^\d{4}-(?:0[1-9]|1[0-2])-01$/.test(body.month)
    ||Object.hasOwn(body,'previous_import_id')&&!uuidValue(body.previous_import_id)||Object.hasOwn(body,'request_id')&&!uuidValue(body.request_id)||Object.hasOwn(body,'complete')&&typeof body.complete!=='boolean'
    ||body.action==='commit'&&(body.complete!==true||!uuidValue(body.previous_import_id)||!uuidValue(body.request_id)))return respond(400,{error:INVALID});
   try{if(parseCivilDate(body.month)!==body.month)throw Error('date');}catch{return respond(400,{error:INVALID});}
   if(body.action==='preview'){
    const preview=await call('/rest/v1/rpc/preview_product_cost_recalculation',{data:{p_cost_import_id:body.cost_import_id,p_month:body.month}});
    if(!preview.ok)return fail(preview);if(!validCostRecalculation(preview.payload,body.cost_import_id,body.month))throw Error('preview');return respond(200,preview.payload);
   }
   const committed=await call('/rest/v1/rpc/commit_product_cost_recalculation_from_gateway',{service:true,data:{p_user_id:auth.payload.id,p_session_id:verifiedSession,p_cost_import_id:body.cost_import_id,p_month:body.month,p_previous_import_id:body.previous_import_id,p_request_id:body.request_id}});
   if(!committed.ok)return fail(committed);const result=committed.payload;
   if(result?.format_version!=='costs-recalculation-v1'||!uuidValue(result.import_id)||result.source_import_id!==body.previous_import_id||result.cost_import_id!==body.cost_import_id||result.month!==body.month||result.request_id!==body.request_id||!Number.isSafeInteger(result.row_count)||result.row_count<1||result.row_count>MAX_ROWS||typeof result.idempotent!=='boolean')throw Error('commit');return respond(200,result);
  }
  if(Object.keys(body).some(k=>!['action','mode','file_name','file_base64','month','reference_date','previous_import_id','complete',...(costs?['resolutions']:[])].includes(k))||typeof body.file_name!=='string'||!body.file_name||body.file_name.length>250||body.file_name!==body.file_name.trim()||/[/\\\u0000-\u001f\u007f]/.test(body.file_name))return respond(400,{error:INVALID});
  const resolutions=costs?(Object.hasOwn(body,'resolutions')?body.resolutions:{}):null;
  if(costs&&!validCostResolutions(resolutions))return respond(400,{error:INVALID});
  if(costs&&Object.hasOwn(body,'previous_import_id')&&body.previous_import_id!==null&&!uuidValue(body.previous_import_id))return respond(400,{error:INVALID});
  const reference=commercial?body.month:body.reference_date;
  if(typeof reference!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(reference)||(commercial&&!reference.endsWith('-01'))||(commercial?Object.hasOwn(body,'reference_date'):Object.hasOwn(body,'month'))||('previous_import_id'in body&&body.previous_import_id!==null&&!UUID.test(body.previous_import_id??''))||('complete'in body&&typeof body.complete!=='boolean')||(body.action==='commit'&&(body.complete!==true||!Object.hasOwn(body,'previous_import_id'))))return respond(400,{error:INVALID});
  if(costs){try{if(parseCivilDate(reference)!==reference)throw Error('date');}catch{return respond(400,{error:INVALID});}}
  if(!/\.(xlsx|xlsm|csv)$/i.test(body.file_name))return respond(400,{error:'Selecione .xlsx, .xlsm ou .csv. Para .xls, salve uma cópia como .xlsx.'});
  let bytes;try{bytes=decode(body.file_base64);}catch{return respond(400,{error:'Selecione um arquivo não vazio de até 2 MiB.'});}
  let parsed;try{
   let matrix,excel1904=false;if(/\.csv$/i.test(body.file_name))matrix=parseCsv(new TextDecoder('utf-8',{fatal:true}).decode(bytes),commercial||costs?undefined:{maxRows:MAX_ROWS+21});else{await validateWorkbookExpandedSize(bytes.buffer);const workbook=await loadWorkbook(bytes.buffer,{mode:body.mode});matrix=workbook.matrix;excel1904=workbook.excel1904===true;}
   if(!Array.isArray(matrix)||matrix.length>MAX_ROWS+(commercial||costs?1:21)||matrix.some(row=>!Array.isArray(row)||row.length>100))throw Error('size');
   parsed=(commercial?validateCommercialRows:costs?validateCostRows:validateHrRows)(matrix,{excel1904});
  }catch{return respond(422,{error:'Importação bloqueada. Nenhum dado foi alterado.',errors:[{line:0,column:'Arquivo',problem:commercial||costs?'Não foi possível analisar o arquivo. Use uma única aba com até 5.000 linhas e 100 colunas, somente com valores.':'Não foi possível analisar o arquivo. Use uma única aba com até 5.000 pessoas, uma linha final de totais e 100 colunas.',correction:commercial||costs?CORRECTION:HR_CORRECTION}]});}
  if(parsed.errors.length)return respond(422,{error:'Importação bloqueada. Nenhum dado foi alterado.',errors:problems(parsed.errors,commercial||costs?CORRECTION:HR_CORRECTION)});
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const referenceArgument=commercial?{p_month:reference}:costs?{p_reference_date:reference,p_resolutions:resolutions}:{p_reference_date:reference,p_report_totals:parsed.totals??null};
  if(body.action==='preview'){
   const preview=await call(`/rest/v1/rpc/${commercial?'preview_commercial_import':costs?'preview_product_cost_import':'preview_hr_sheet_import'}`,{data:{p_rows:parsed.rows,...referenceArgument}});if(!preview.ok)return fail(preview);
   if(costs){if(!validCostPreview(preview.payload,parsed.rows,reference,resolutions))throw Error('preview');const{rows,...details}=preview.payload;return respond(200,{rows,preview:details,file_sha256:hash,format_version:'costs-v1'});}
   if(preview.payload?.row_count!==parsed.rows.length||!(preview.payload.previous_import_id===null||UUID.test(preview.payload.previous_import_id??'')))throw Error('preview');
   const rows=commercial?parsed.rows:preview.payload.rows;
   if(!Array.isArray(rows)||rows.length!==parsed.rows.length||!commercial&&preview.payload.summary?.total_formula_version!=='rh-reported-total-v1')throw Error('preview');
   const {rows:projectedRows,...details}=preview.payload;
   return respond(200,{rows,preview:commercial?preview.payload:details,file_sha256:hash,...commercial?{}:{format_version:4}});
  }
  const committed=await call(`/rest/v1/rpc/${commercial?'commit_commercial_import_from_gateway':costs?'commit_product_cost_import_from_gateway':'commit_hr_sheet_import_from_gateway'}`,{service:true,data:{p_user_id:auth.payload.id,p_session_id:verifiedSession,p_file_name:body.file_name,p_file_sha256:hash,p_file_base64:body.file_base64,p_rows:parsed.rows,...referenceArgument,p_previous_import_id:body.previous_import_id}});
  if(!committed.ok)return fail(committed);if(!UUID.test(committed.payload?.import_id??'')||committed.payload.row_count!==parsed.rows.length||costs&&(committed.payload.format_version!=='costs-v1'||committed.payload.reference_date!==reference||!Number.isSafeInteger(committed.payload.item_count)||committed.payload.item_count<1||committed.payload.item_count>parsed.rows.length||typeof committed.payload.idempotent!=='boolean'))throw Error('commit');return respond(200,committed.payload);
 }catch{log('request_unavailable');return respond(503,{error:FAILURE});}
};}
