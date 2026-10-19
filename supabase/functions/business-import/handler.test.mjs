import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import ExcelJS from 'exceljs';
import {createBusinessGateway} from './handler.mjs';
const uid='91000000-0000-4000-8000-000000000001',session='91000000-0000-4000-8000-000000000002',importId='91000000-0000-4000-8000-000000000003';
const token=`e30.${Buffer.from(JSON.stringify({sub:uid,session_id:session})).toString('base64url')}.signature`,origin='https://central.example';
const csv='Produto;Venda total;Emissão;Cliente;Filial;CMV;Frete;Imposto;Comissão;Margem final R$\r\nProduto sintético;100,00;01/10/2026;Cliente sintético;A;50,00;1,00;10,00;4,00;0,00';
const base64=Buffer.from(csv).toString('base64');
const permissions=[{resource:'importar_bases',action:'read'},{resource:'fechamento',action:'import'},{resource:'faturamento',action:'read'},{resource:'rh_dp',action:'read'},{resource:'rh_dp',action:'write'},{resource:'rh_dp',action:'import'}];
const body=(extra={})=>({action:'preview',mode:'commercial',month:'2026-10-01',file_name:'synthetic.csv',file_base64:base64,...extra});
const request=(data=body(),headers={})=>new Request('https://functions.example/business-import',{method:'POST',headers:{origin,authorization:`Bearer ${token}`,'content-type':'application/json',...headers},body:JSON.stringify(data)});
function fixture({grants=permissions,authStatus=200,accessStatus=200,upstreamFailure,loadWorkbook}={}){
 const calls=[];let loaded=0;
 const gateway=createBusinessGateway({env:name=>({ALLOWED_ORIGINS:origin,SUPABASE_URL:'https://project.example',SUPABASE_ANON_KEY:'public-key',SUPABASE_SERVICE_ROLE_KEY:'server-only-key'}[name]),loadWorkbook:async buffer=>{loaded++;return loadWorkbook(buffer);},fetch:async(url,options)=>{
  const data=options.body===undefined?undefined:JSON.parse(options.body);calls.push({url,data,headers:options.headers});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:uid},{status:authStatus});
  if(url.endsWith('/current_access'))return Response.json({profile:{id:uid,enabled:true},permissions:grants},{status:accessStatus});
  if(upstreamFailure)return Response.json(upstreamFailure,{status:400});
  if(url.includes('/preview_'))return Response.json({row_count:data.p_rows.length,previous_import_id:null,sale_cents:10000,margin_cents:0});
  if(url.includes('/commit_'))return Response.json({import_id:importId,row_count:data.p_rows.length,idempotent:false});
  throw Error('Unexpected request');
 }});
 return {gateway,calls,loaded:()=>loaded};
}
test('business preview parses preserved original bytes canonically and preserves reported zero margin',async()=>{
 const f=fixture(),response=await f.gateway(request()),result=await response.json();assert.equal(response.status,200);assert.equal(result.rows[0].sale_cents,10000);assert.equal(result.rows[0].margin_cents,0);assert.equal(result.rows[0].margin_source,'PROVIDED');assert.equal(result.file_sha256,createHash('sha256').update(csv).digest('hex'));assert(f.calls.at(-1).url.endsWith('/preview_commercial_import'));assert.equal(f.calls.at(-1).data.p_month,'2026-10-01');assert.equal(f.calls.at(-1).headers.Authorization,`Bearer ${token}`);
});
test('business commit reparses and sends only trusted actor/session and original hash using service RPC',async()=>{
 const f=fixture(),response=await f.gateway(request(body({action:'commit',complete:true,previous_import_id:null})));assert.equal(response.status,200);const commit=f.calls.at(-1);assert(commit.url.endsWith('/commit_commercial_import_from_gateway'));assert.equal(commit.headers.Authorization,'Bearer server-only-key');assert.equal(commit.data.p_user_id,uid);assert.equal(commit.data.p_session_id,session);assert.equal(commit.data.p_file_base64,base64);assert.equal(commit.data.p_rows[0].margin_cents,0);
});
test('business denies invalid sessions and module permissions before decoding files or loading workbooks',async()=>{
 for(const settings of [{authStatus:401},{grants:[]},{grants:[{resource:'importar_bases',action:'read'},{resource:'rh_dp',action:'import'}]}]){const f=fixture(settings),response=await f.gateway(request(body({file_name:'synthetic.xlsx',file_base64:'NOT_BASE64'})));assert([401,403].includes(response.status));assert.equal(f.loaded(),0);assert(!f.calls.some(call=>call.url.includes('/preview_')));}
});
test('business rejects untrusted caller rows, actor IDs and absent explicit full snapshot confirmation',async()=>{
 for(const changes of [{rows:[]},{actor_id:uid},{action:'commit',previous_import_id:null},{action:'commit',complete:true},{file_name:'../synthetic.csv'},{mode:'commercial',reference_date:'2026-10-01'}]){const f=fixture(),response=await f.gateway(request(body(changes)));assert.equal(response.status,400);assert.equal(f.calls.length,2);}
});
test('business blocks corrupt canonical rows without calling a mutation',async()=>{
 for(const source of [csv.replace('100,00','inválido'),csv.replace('100,00','=100'),csv.replace('01/10/2026','31/02/2026')]){const f=fixture(),response=await f.gateway(request(body({file_base64:Buffer.from(source).toString('base64')})));assert.equal(response.status,422);const result=await response.json();assert.equal(result.errors[0].line,2);assert.equal(f.calls.length,2);}
});
test('business validates allowed origin and strict CORS preflight without contacting upstream',async()=>{
 const f=fixture();assert.equal((await f.gateway(request(body(),{origin:'https://evil.example'}))).status,403);assert.equal(f.calls.length,0);
 const allowed=await f.gateway(new Request('https://functions.example',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'authorization, content-type'}}));assert.equal(allowed.status,204);assert.equal(allowed.headers.get('access-control-allow-origin'),origin);
 const denied=await f.gateway(new Request('https://functions.example',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'x-admin'}}));assert.equal(denied.status,403);
});
test('business maps stale previews and missing migration safely without forwarding database details',async()=>{
 for(const [failure,status,code]of [[{code:'40001',message:'private-values'},409,'40001'],[{code:'PGRST202',message:'private-values'},409,'P0032'],[{code:'42501',message:'private-values'},403,'42501'],[{code:'unknown',message:'private-values'},503,undefined]]){const f=fixture({upstreamFailure:failure}),response=await f.gateway(request());assert.equal(response.status,status);const text=await response.text();assert(!text.includes('private-values'));assert.equal(JSON.parse(text).code,code);}
});
test('HR uses its canonical parser, reference date and separate guarded RPC',async()=>{
 const source='FILIAL;ADMISSÃO;ANIVERSÁRIO;SALÁRIO;SETOR;FUNCIONÁRIO;VT TOTAL;SALÁRIO;ADIANTAMENTO;TOTAL\r\nA;01/01/2020;01/01/2000;2.000,00;OPERAÇÃO;Pessoa sintética;100,00;1.500,00;300,00;2.100,00';
 const f=fixture(),data={action:'preview',mode:'hr',reference_date:'2026-10-19',file_name:'hr.csv',file_base64:Buffer.from(source).toString('base64')};const response=await f.gateway(request(data));assert.equal(response.status,200);const result=await response.json();assert.equal(result.rows[0].salary_base_cents,200000);assert.equal(result.rows[0].payroll_salary_cents,150000);assert(f.calls.at(-1).url.endsWith('/preview_hr_report_import'));assert.equal(f.calls.at(-1).data.p_reference_date,'2026-10-19');
 const noWrite=fixture({grants:permissions.filter(p=>p.resource!=='rh_dp'||p.action!=='write')});assert.equal((await noWrite.gateway(request(data))).status,403);
});
test('business rejects oversized JSON and noncanonical base64 with no persistence',async()=>{
 for(const changes of [{file_base64:'eA='},{file_base64:'eA==\n'},{file_base64:'A'.repeat(2796208)}]){const f=fixture();assert.equal((await f.gateway(request(body(changes)))).status,400);assert.equal(f.calls.length,2);}
});
test('actual RH headers and accounting cells survive XLSX preview and canonical commit without losing either salary or allowance',async()=>{
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Posição sintética');
 sheet.addRows([['FILIAL','ADMISSAO','ANIVERSARIO','Salário Base','VT TOTAL','Salário','Adiantamento','Ajuda de Custo','SETOR','Funcionário'],
  ['Unidade sintética',new Date('2020-03-01T00:00:00Z'),new Date('1990-05-20T00:00:00Z'),2500,0,1850.75,null,480.25,'Área sintética','Pessoa sintética']]);
 for(const column of [2,3])sheet.getRow(2).getCell(column).numFmt='dd/mm/yyyy';
 for(const column of [4,5,6,7,8])sheet.getRow(2).getCell(column).numFmt='"R$" #,##0.00;[Red]-"R$" #,##0.00;"R$" -';
 const bytes=Buffer.from(await book.xlsx.writeBuffer());
 const f=fixture({loadWorkbook:async buffer=>{const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(buffer);return{matrix:loaded.worksheets[0].getSheetValues().slice(1).map(row=>row.slice(1)),excel1904:false};}});
 const data={action:'preview',mode:'hr',reference_date:'2026-10-19',file_name:'rh-sintetico.xlsx',file_base64:bytes.toString('base64')};
 const response=await f.gateway(request(data));assert.equal(response.status,200);const result=await response.json();
 const parsed=result.rows[0];assert.equal(parsed.salary_base_cents,250000);assert.equal(parsed.payroll_salary_cents,185075);assert.equal(parsed.cost_allowance_cents,48025);
 assert.equal(parsed.transport_cents,0);assert.equal(parsed.advance_cents,0);assert.equal(parsed.total_cents,null);assert.equal(parsed.admitted_on,'2020-03-01');
 assert(f.calls.at(-1).url.endsWith('/preview_hr_report_import'));assert.equal(result.file_sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal((await f.gateway(request({...data,action:'commit',complete:true,previous_import_id:null}))).status,200);
 const commit=f.calls.at(-1);assert(commit.url.endsWith('/commit_hr_report_import_from_gateway'));assert.deepEqual(commit.data.p_rows,result.rows);assert.equal(commit.data.p_file_base64,data.file_base64);assert.equal(commit.data.p_user_id,uid);assert.equal(f.loaded(),2);
});
