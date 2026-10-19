import { MAX_FILE_BYTES, MAX_ROWS, parseCsv, validateWorkbookExpandedSize } from '../../../src/lib/payables-parser.mjs';
import { validateCommercialRows } from '../../../src/lib/commercial-parser.mjs';
import { validateHrRows } from '../../../src/lib/hr-parser.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FAILURE='Não foi possível confirmar a operação. Atualize o histórico antes de tentar novamente.';
const INVALID='Solicitação inválida. Selecione novamente o relatório completo.';
const CORRECTION='Confira os cabeçalhos e salve uma cópia somente com valores.';
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
const problems=errors=>errors.slice(0,100).map(row=>({line:Number.isSafeInteger(row.line)&&row.line>=0&&row.line<=5020?row.line:0,column:String(row.column||'Arquivo').slice(0,100),problem:String(row.problem||'Linha inválida.').slice(0,400),correction:String(row.correction||CORRECTION).slice(0,400)}));

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
 function fail(result){const code=result.payload?.code;if(code==='42501')return respond(403,{code,error:'Seu perfil não tem permissão para esta operação.'});if(code==='40001')return respond(409,{code,error:'A base mudou. Analise o relatório novamente.'});if(['PGRST202','42P01','42883'].includes(code))return respond(409,{code:'P0032',error:'Ative a atualização do banco antes de importar.'});if(['22023','22007','22008','23514','22003','22P02'].includes(code))return respond(400,{code:'22023',error:'Confira o mês de referência e as linhas do relatório.'});if(result.status===401)return respond(401,{error:'Sua sessão expirou. Entre novamente.'});log('upstream_unavailable');return respond(503,{error:FAILURE});}
 try{
  const auth=await call('/auth/v1/user',{method:'GET'});if(!auth.ok)return auth.status===401||auth.status===403?respond(401,{error:'Sua sessão expirou. Entre novamente.'}):fail(auth);
  if(!UUID.test(auth.payload?.id??''))throw Error('identity');let verifiedSession;try{verifiedSession=sessionId(token,auth.payload.id);}catch{return respond(401,{error:'Sua sessão expirou. Entre novamente.'});}
  const access=await call('/rest/v1/rpc/current_access',{data:{}});if(!access.ok)return fail(access);
  const permissions=access.payload?.permissions,has=(resource,action='read')=>Array.isArray(permissions)&&permissions.some(p=>p?.resource===resource&&p.action===action);
  if(access.payload?.profile?.id!==auth.payload.id||access.payload.profile.enabled!==true||!has('importar_bases')||!(has('fechamento','import')||has('rh_dp','import')))return respond(403,{code:'42501',error:'Seu perfil não tem permissão para esta operação.'});
  let body;try{body=await bodyOf(request);}catch{return respond(400,{error:INVALID});}
  if(Object.keys(body).some(k=>!['action','mode','file_name','file_base64','month','reference_date','previous_import_id','complete'].includes(k))||!['preview','commit'].includes(body.action)||!['commercial','hr'].includes(body.mode)||typeof body.file_name!=='string'||!body.file_name||body.file_name.length>250||body.file_name!==body.file_name.trim()||/[/\\\u0000-\u001f\u007f]/.test(body.file_name))return respond(400,{error:INVALID});
  const commercial=body.mode==='commercial';if(!(commercial?has('fechamento','import')&&has('faturamento'):has('rh_dp','import')&&has('rh_dp')&&has('rh_dp','write')))return respond(403,{code:'42501',error:'Seu perfil não tem permissão para esta operação.'});
  const reference=commercial?body.month:body.reference_date;
  if(typeof reference!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(reference)||(commercial&&!reference.endsWith('-01'))||(commercial?Object.hasOwn(body,'reference_date'):Object.hasOwn(body,'month'))||('previous_import_id'in body&&body.previous_import_id!==null&&!UUID.test(body.previous_import_id??''))||('complete'in body&&typeof body.complete!=='boolean')||(body.action==='commit'&&(body.complete!==true||!Object.hasOwn(body,'previous_import_id'))))return respond(400,{error:INVALID});
  if(!/\.(xlsx|xlsm|csv)$/i.test(body.file_name))return respond(400,{error:'Selecione .xlsx, .xlsm ou .csv. Para .xls, salve uma cópia como .xlsx.'});
  let bytes;try{bytes=decode(body.file_base64);}catch{return respond(400,{error:'Selecione um arquivo não vazio de até 2 MiB.'});}
  let parsed;try{
   let matrix,excel1904=false;if(/\.csv$/i.test(body.file_name))matrix=parseCsv(new TextDecoder('utf-8',{fatal:true}).decode(bytes));else{await validateWorkbookExpandedSize(bytes.buffer);const workbook=await loadWorkbook(bytes.buffer);matrix=workbook.matrix;excel1904=workbook.excel1904===true;}
   if(!Array.isArray(matrix)||matrix.length>MAX_ROWS+(commercial?1:20)||matrix.some(row=>!Array.isArray(row)||row.length>100))throw Error('size');
   parsed=(commercial?validateCommercialRows:validateHrRows)(matrix,{excel1904});
  }catch{return respond(422,{error:'Importação bloqueada. Nenhum dado foi alterado.',errors:[{line:0,column:'Arquivo',problem:'Não foi possível analisar o arquivo. Use uma única aba com até 5.000 linhas e 100 colunas, somente com valores.',correction:CORRECTION}]});}
  if(parsed.errors.length)return respond(422,{error:'Importação bloqueada. Nenhum dado foi alterado.',errors:problems(parsed.errors)});
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const referenceArgument=commercial?{p_month:reference}:{p_reference_date:reference};
  if(body.action==='preview'){
   const preview=await call(`/rest/v1/rpc/${commercial?'preview_commercial_import':'preview_hr_import'}`,{data:{p_rows:parsed.rows,...referenceArgument}});if(!preview.ok)return fail(preview);
   if(preview.payload?.row_count!==parsed.rows.length||!(preview.payload.previous_import_id===null||UUID.test(preview.payload.previous_import_id??'')))throw Error('preview');
   return respond(200,{rows:parsed.rows,preview:preview.payload,file_sha256:hash});
  }
  const committed=await call(`/rest/v1/rpc/${commercial?'commit_commercial_import_from_gateway':'commit_hr_import_from_gateway'}`,{service:true,data:{p_user_id:auth.payload.id,p_session_id:verifiedSession,p_file_name:body.file_name,p_file_sha256:hash,p_file_base64:body.file_base64,p_rows:parsed.rows,...referenceArgument,p_previous_import_id:body.previous_import_id}});
  if(!committed.ok)return fail(committed);if(!UUID.test(committed.payload?.import_id??'')||committed.payload.row_count!==parsed.rows.length)throw Error('commit');return respond(200,committed.payload);
 }catch{log('request_unavailable');return respond(503,{error:FAILURE});}
};}
