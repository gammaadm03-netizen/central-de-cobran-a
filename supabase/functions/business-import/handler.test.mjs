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
function fixture({grants=permissions,authStatus=200,accessStatus=200,upstreamFailure,loadWorkbook,hrPreview,costPreview,costCommit,recalculationPreview,recalculationCommit}={}){
 const calls=[];let loaded=0;
 const gateway=createBusinessGateway({env:name=>({ALLOWED_ORIGINS:origin,SUPABASE_URL:'https://project.example',SUPABASE_ANON_KEY:'public-key',SUPABASE_SERVICE_ROLE_KEY:'server-only-key'}[name]),loadWorkbook:async buffer=>{loaded++;return loadWorkbook(buffer);},fetch:async(url,options)=>{
  const data=options.body===undefined?undefined:JSON.parse(options.body);calls.push({url,data,headers:options.headers});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:uid},{status:authStatus});
  if(url.endsWith('/current_access'))return Response.json({profile:{id:uid,enabled:true},permissions:grants},{status:accessStatus});
  if(upstreamFailure)return Response.json(upstreamFailure,{status:400});
  if(url.endsWith('/preview_product_cost_import'))return Response.json(costPreview?costPreview(data):costPayload(data));
  if(url.endsWith('/commit_product_cost_import_from_gateway'))return Response.json(costCommit?costCommit(data):{format_version:'costs-v1',import_id:importId,row_count:data.p_rows.length,item_count:new Set(data.p_rows.map(row=>row.code)).size,reference_date:data.p_reference_date,idempotent:false});
  if(url.endsWith('/preview_product_cost_recalculation'))return Response.json(recalculationPreview?recalculationPreview(data):recalculationPayload(data));
  if(url.endsWith('/commit_product_cost_recalculation_from_gateway'))return Response.json(recalculationCommit?recalculationCommit(data):{format_version:'costs-recalculation-v1',import_id:derivedImportId,source_import_id:data.p_previous_import_id,cost_import_id:data.p_cost_import_id,month:data.p_month,row_count:1,idempotent:false,request_id:data.p_request_id});
  if(url.endsWith('/preview_hr_sheet_import'))return Response.json(hrPreview?hrPreview(data):{row_count:data.p_rows.length,previous_import_id:null,summary:{total_formula_version:'rh-reported-total-v1'},rows:data.p_rows.map(row=>({...row,reported_total_cents:row.total_cents}))});
  if(url.includes('/preview_'))return Response.json({row_count:data.p_rows.length,previous_import_id:null,sale_cents:10000,margin_cents:0});
  if(url.includes('/commit_'))return Response.json({import_id:importId,row_count:data.p_rows.length,idempotent:false});
  throw Error('Unexpected request');
 }});
 return {gateway,calls,loaded:()=>loaded};
}
test('business preview parses preserved original bytes canonically and preserves reported zero margin',async()=>{
 const f=fixture(),response=await f.gateway(request()),result=await response.json();assert.equal(response.status,200);assert.equal(result.rows[0].sale_cents,10000);assert.equal(result.rows[0].margin_cents,0);assert.equal(result.rows[0].margin_source,'PROVIDED');assert.equal(result.file_sha256,createHash('sha256').update(csv).digest('hex'));assert(f.calls.at(-1).url.endsWith('/preview_commercial_import'));assert.equal(f.calls.at(-1).data.p_month,'2026-10-01');assert.equal(f.calls.at(-1).headers.Authorization,`Bearer ${token}`);
});
const costImportId='91000000-0000-4000-8000-000000000004',derivedImportId='91000000-0000-4000-8000-000000000005',recalculationRequestId='91000000-0000-4000-8000-000000000006';
const costPermissions=[{resource:'importar_bases',action:'read'},{resource:'custos',action:'import'},{resource:'margens',action:'read'}];
const recalculationPermissions=[...costPermissions,{resource:'fechamento',action:'import'},{resource:'faturamento',action:'read'}];
const costCsv='Produto: código;Produto: nome;peso;custo atual\r\n001;Produto sintético;;12,345678\r\n001;Produto sintético;;12,345678\r\n002;Outro produto sintético;0,125;0\r\n002;Outro produto sintético;0,125;6,56';
const costBody=(extra={})=>({action:'preview',mode:'costs',reference_date:'2026-10-20',file_name:'custos-sinteticos.csv',file_base64:Buffer.from(costCsv).toString('base64'),resolutions:{},...extra});
function costPayload(data){
 const selected=data.p_resolutions['002']??null,valid=selected===4||selected===5;
 return{format_version:'costs-v1',reference_date:data.p_reference_date,previous_import_id:null,row_count:4,item_count:2,can_commit:valid,zero_cost_count:selected===4?1:0,missing_weight_count:valid?1:2,missing_cost_count:valid?0:1,duplicate_row_count:2,duplicate_code_count:2,conflicting_cost_code_count:1,unresolved_count:valid?0:1,new_count:2,changed_count:0,unchanged_count:0,removed_count:0,exact_duplicate_count:1,
  rows:[{...data.p_rows[0],source_lines:[2,3],duplicate_count:1,cost_conflict:false,resolved:true,selected_line_number:null},
   {...data.p_rows[valid?selected-2:2],unit_cost:valid?data.p_rows[selected-2].unit_cost:null,weight_kg:valid?data.p_rows[selected-2].weight_kg:null,source_lines:[4,5],duplicate_count:1,cost_conflict:true,resolved:valid,selected_line_number:selected}],
  conflicts:[{code:'002',product:'Outro produto sintético',selected_line_number:selected,options:data.p_rows.slice(2).map(row=>({line_number:row.line_number,unit_cost:row.unit_cost,weight_kg:row.weight_kg}))}]};
}
const recalculationBody=(extra={})=>({action:'preview',mode:'costs_recalculation',month:'2026-10-01',cost_import_id:costImportId,...extra});
function recalculationPayload(data){return{format_version:'costs-recalculation-v1',month:data.p_month,cost_import_id:data.p_cost_import_id,previous_import_id:importId,revision:'closing-and-catalogue-revision',can_apply:true,row_count:1,matched_count:1,missing_code_count:0,missing_quantity_count:0,invalid_quantity_count:0,missing_cost_count:0,zero_cost_count:0,missing_components_count:0,totals:{previous_cost_cents:1000,new_cost_cents:2469,previous_margin_cents:9000,new_margin_cents:7531},source:{import_id:importId,month:data.p_month,file_name:'Fechamento sintético.csv'},cost_source:{import_id:data.p_cost_import_id,reference_date:'2026-10-20',file_name:'Custos sintéticos.csv'},rows:[{id:'91000000-0000-4000-8000-000000000007',line_number:2,code:'001',product:'Produto sintético',invoice:'NF-SINT',branch:'A',quantity:'2',unit_cost:'12.345678',previous_cost_cents:1000,new_cost_cents:2469,previous_margin_cents:9000,new_margin_cents:7531,error_codes:[]}]};}
test('cost catalogue preview preserves every original line, exact unit precision and explicit unresolved alternatives',async()=>{
 const f=fixture({grants:costPermissions}),response=await f.gateway(request(costBody())),result=await response.json();
 assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.format_version,'costs-v1');assert.equal(result.preview.row_count,4);assert.equal(result.rows.length,2);assert.equal(result.preview.can_commit,false);assert.equal(result.rows[0].unit_cost,'12.345678');assert.equal(result.rows[0].code,'001');assert.equal(result.rows[1].unit_cost,null);assert.equal(result.preview.conflicts[0].options[0].unit_cost,'0');
 assert.equal(result.file_sha256,createHash('sha256').update(costCsv).digest('hex'));const call=f.calls.at(-1);assert(call.url.endsWith('/preview_product_cost_import'));assert.equal(call.data.p_rows.length,4);assert.equal(call.data.p_rows[1].line_number,3);assert.deepEqual(call.data.p_resolutions,{});assert.equal(call.headers.Authorization,`Bearer ${token}`);
});
test('cost catalogue commit reparses preserved bytes and forwards the exact choice with verified actor and session',async()=>{
 const f=fixture({grants:costPermissions}),data=costBody({resolutions:{'002':5}});
 const preview=await f.gateway(request(data));assert.equal(preview.status,200);assert.equal((await preview.json()).preview.can_commit,true);
 const response=await f.gateway(request({...data,action:'commit',complete:true,previous_import_id:null})),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.item_count,2);
 const call=f.calls.at(-1);assert(call.url.endsWith('/commit_product_cost_import_from_gateway'));assert.deepEqual(call.data.p_resolutions,{'002':5});assert.equal(call.data.p_rows.length,4);assert.equal(call.data.p_rows[3].unit_cost,'6.56');assert.equal(call.data.p_file_base64,data.file_base64);assert.equal(call.data.p_user_id,uid);assert.equal(call.data.p_session_id,session);assert.equal(call.headers.Authorization,'Bearer server-only-key');
});
test('cost catalogue requires all module permissions before parsing and does not expose the file to another importer',async()=>{
 for(const grants of [permissions,costPermissions.filter(p=>p.resource!=='custos'),costPermissions.filter(p=>p.resource!=='margens'),costPermissions.filter(p=>p.resource!=='importar_bases')]){const f=fixture({grants}),response=await f.gateway(request(costBody({file_name:'source.xlsx',file_base64:'BAD'})));assert.equal(response.status,403);assert.equal(f.loaded(),0);assert.equal(f.calls.length,2);}
});
test('cost catalogue rejects caller rows, forged choices, invalid dates and cross-mode fields before persistence',async()=>{
 for(const extra of [{rows:[]},{p_rows:[]},{p_user_id:uid},{resolutions:null},{resolutions:[]},{resolutions:{'002':'5'}},{resolutions:{'002':1}},{resolutions:{'002':5002}},{month:'2026-10-01'},{reference_date:'2026-02-31'}]){const f=fixture({grants:costPermissions}),response=await f.gateway(request(costBody(extra)));assert.equal(response.status,400,JSON.stringify(extra));assert.equal(f.calls.length,2);}
});
test('cost catalogue refuses an old response or an explicit choice that the service silently ignored',async()=>{
 for(const changes of [()=>({row_count:4,previous_import_id:null}),data=>{const p=costPayload(data);p.rows[1].selected_line_number=null;return p;},data=>{const p=costPayload(data);p.rows[1].unit_cost='0';return p;},data=>{const p=costPayload(data);p.rows[0].source_lines=[2];return p;}]){const f=fixture({grants:costPermissions,costPreview:changes}),response=await f.gateway(request(costBody({resolutions:{'002':5}})));assert.equal(response.status,503);assert(!(await response.text()).includes('Produto sintético'));}
});
test('cost catalogue reports its own activation code and never forwards database internals',async()=>{
 const f=fixture({grants:costPermissions,upstreamFailure:{code:'PGRST202',message:'sensitive source function signature'}}),response=await f.gateway(request(costBody()));assert.equal(response.status,409);const text=await response.text();assert.equal(JSON.parse(text).code,'P0044');assert(!text.includes('sensitive'));
});
test('cost recalculation preview is fileless and preserves server-calculated original and replacement financial totals',async()=>{
 const f=fixture({grants:recalculationPermissions}),response=await f.gateway(request(recalculationBody())),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.format_version,'costs-recalculation-v1');assert.equal(result.totals.new_cost_cents,2469);assert.equal(result.rows[0].unit_cost,'12.345678');assert.equal(f.loaded(),0);
 const call=f.calls.at(-1);assert(call.url.endsWith('/preview_product_cost_recalculation'));assert.deepEqual(call.data,{p_cost_import_id:costImportId,p_month:'2026-10-01'});assert.equal(call.headers.Authorization,`Bearer ${token}`);
});
test('cost recalculation commit sends only the frozen source, catalogue and protocol to the service-only writer',async()=>{
 const f=fixture({grants:recalculationPermissions}),response=await f.gateway(request(recalculationBody({action:'commit',complete:true,previous_import_id:importId,request_id:recalculationRequestId}))),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.import_id,derivedImportId);assert.equal(result.request_id,recalculationRequestId);assert.equal(f.loaded(),0);
 const call=f.calls.at(-1);assert.deepEqual(call.data,{p_user_id:uid,p_session_id:session,p_cost_import_id:costImportId,p_month:'2026-10-01',p_previous_import_id:importId,p_request_id:recalculationRequestId});assert.equal(call.headers.Authorization,'Bearer server-only-key');
});
test('cost recalculation requires closing and sales permissions in addition to catalogue access',async()=>{
 for(const grants of [costPermissions,recalculationPermissions.filter(p=>p.resource!=='fechamento'),recalculationPermissions.filter(p=>p.resource!=='faturamento'),recalculationPermissions.filter(p=>p.resource!=='margens')]){const f=fixture({grants}),response=await f.gateway(request(recalculationBody()));assert.equal(response.status,403);assert.equal(f.calls.length,2);assert.equal(f.loaded(),0);}
});
test('cost recalculation rejects files, replacement rows and commits without an exact confirmed source or protocol',async()=>{
 for(const extra of [{file_name:'forged.csv'},{file_base64:base64},{rows:[]},{reference_date:'2026-10-20'},{p_user_id:uid},{cost_import_id:[costImportId]},{month:'2026-10-20'},{month:'2200-01-01'},{action:'commit',complete:true,previous_import_id:importId},{action:'commit',request_id:recalculationRequestId,previous_import_id:importId},{action:'commit',complete:true,request_id:recalculationRequestId,previous_import_id:null}]){const f=fixture({grants:recalculationPermissions}),response=await f.gateway(request(recalculationBody(extra)));assert.equal(response.status,400,JSON.stringify(extra));assert.equal(f.calls.length,2);}
});
test('cost recalculation refuses inconsistent totals, non-matching sources and unsupported response versions',async()=>{
 for(const mutate of [p=>{p.totals.new_margin_cents++;},p=>{p.rows[0].unit_cost=null;},p=>{p.rows[0].unit_cost='0';p.zero_cost_count=1;},p=>{p.rows[0].quantity='0';},p=>{p.source.import_id=costImportId;},p=>{p.format_version='old';},p=>{p.rows[0].error_codes=['MISSING_COST'];}]){const f=fixture({grants:recalculationPermissions,recalculationPreview:data=>{const p=recalculationPayload(data);mutate(p);return p;}}),response=await f.gateway(request(recalculationBody()));assert.equal(response.status,503);assert(!(await response.text()).includes('Produto sintético'));}
});
test('cost recalculation activation and uncertain commits preserve only safe protocol diagnostics',async()=>{
 const unavailable=fixture({grants:recalculationPermissions,upstreamFailure:{code:'42883',message:'private SQL signature'}}),response=await unavailable.gateway(request(recalculationBody()));assert.equal(response.status,409);assert.equal((await response.json()).code,'P0045');
 const mismatch=fixture({grants:recalculationPermissions,recalculationCommit:data=>({...recalculationPayload(data),format_version:'costs-recalculation-v1',import_id:derivedImportId,source_import_id:data.p_previous_import_id,cost_import_id:data.p_cost_import_id,month:data.p_month,row_count:1,idempotent:false,request_id:uid})});assert.equal((await mismatch.gateway(request(recalculationBody({action:'commit',complete:true,previous_import_id:importId,request_id:recalculationRequestId})))).status,503);
});
test('business commit reparses and sends only trusted actor/session and original hash using service RPC',async()=>{
 const f=fixture(),response=await f.gateway(request(body({action:'commit',complete:true,previous_import_id:null})));assert.equal(response.status,200);const commit=f.calls.at(-1);assert(commit.url.endsWith('/commit_commercial_import_from_gateway'));assert.equal(commit.headers.Authorization,'Bearer server-only-key');assert.equal(commit.data.p_user_id,uid);assert.equal(commit.data.p_session_id,session);assert.equal(commit.data.p_file_base64,base64);assert.equal(commit.data.p_rows[0].margin_cents,0);
});
test('business denies invalid sessions and module permissions before decoding files or loading workbooks',async()=>{
 for(const settings of [{authStatus:401},{grants:[]},{grants:[{resource:'importar_bases',action:'read'},{resource:'rh_dp',action:'import'}]}]){const f=fixture(settings),response=await f.gateway(request(body({file_name:'synthetic.xlsx',file_base64:'NOT_BASE64'})));assert([401,403].includes(response.status));assert.equal(f.loaded(),0);assert(!f.calls.some(call=>call.url.includes('/preview_')));}
});
test('business rejects untrusted caller rows, actor IDs and absent explicit full snapshot confirmation',async()=>{
 for(const changes of [{rows:[]},{actor_id:uid},{report_totals:{}},{p_report_totals:{}},{action:'commit',previous_import_id:null},{action:'commit',complete:true},{file_name:'../synthetic.csv'},{mode:'commercial',reference_date:'2026-10-01'}]){const f=fixture(),response=await f.gateway(request(body(changes)));assert.equal(response.status,400);assert.equal(f.calls.length,2);}
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
 const f=fixture(),data={action:'preview',mode:'hr',reference_date:'2026-10-19',file_name:'hr.csv',file_base64:Buffer.from(source).toString('base64')};const response=await f.gateway(request(data));assert.equal(response.status,200);const result=await response.json();assert.equal(result.rows[0].salary_base_cents,200000);assert.equal(result.rows[0].payroll_salary_cents,150000);assert(f.calls.at(-1).url.endsWith('/preview_hr_sheet_import'));assert.equal(f.calls.at(-1).data.p_reference_date,'2026-10-19');assert.equal(f.calls.at(-1).data.p_report_totals,null);assert.equal(result.format_version,4);
 const noWrite=fixture({grants:permissions.filter(p=>p.resource!=='rh_dp'||p.action!=='write')});assert.equal((await noWrite.gateway(request(data))).status,403);
});
test('business rejects oversized JSON and noncanonical base64 with no persistence',async()=>{
 for(const changes of [{file_base64:'eA='},{file_base64:'eA==\n'},{file_base64:'A'.repeat(2796208)}]){const f=fixture();assert.equal((await f.gateway(request(body(changes)))).status,400);assert.equal(f.calls.length,2);}
});
test('actual RH headers and accounting cells survive XLSX preview and canonical commit without losing either salary or allowance',async()=>{
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Posição sintética');
 sheet.addRows([['FILIAL','ADMISSAO','ANIVERSARIO','Salário Folha','VT TOTAL','Salário recebido','Adiantamento','Ajuda de Custo','SETOR','Funcionário'],
  ['Unidade sintética',new Date('2020-03-01T00:00:00Z'),new Date('1990-05-20T00:00:00Z'),2500,0,1850.75,null,480.25,'Área sintética','Pessoa sintética']]);
 for(const column of [2,3])sheet.getRow(2).getCell(column).numFmt='dd/mm/yyyy';
 for(const column of [4,5,6,7,8])sheet.getRow(2).getCell(column).numFmt='"R$" #,##0.00;[Red]-"R$" #,##0.00;"R$" -';
 const bytes=Buffer.from(await book.xlsx.writeBuffer());
 const f=fixture({hrPreview:data=>({row_count:1,previous_import_id:null,summary:{total_formula_version:'rh-reported-total-v1',total_cents:null},rows:[{...data.p_rows[0],reported_total_cents:null}]}),loadWorkbook:async buffer=>{const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(buffer);return{matrix:loaded.worksheets[0].getSheetValues().slice(1).map(row=>row.slice(1)),excel1904:false};}});
 const data={action:'preview',mode:'hr',reference_date:'2026-10-19',file_name:'rh-sintetico.xlsx',file_base64:bytes.toString('base64')};
 const response=await f.gateway(request(data));assert.equal(response.status,200);const result=await response.json();
 const parsed=result.rows[0];assert.equal(parsed.salary_base_cents,250000);assert.equal(parsed.payroll_salary_cents,185075);assert.equal(parsed.cost_allowance_cents,48025);
 assert.equal(parsed.transport_cents,0);assert.equal(parsed.advance_cents,0);assert.equal(parsed.total_cents,null);assert.equal(parsed.reported_total_cents,null);assert.equal(result.preview.summary.total_cents,null);assert.equal(parsed.admitted_on,'2020-03-01');
 assert(f.calls.at(-1).url.endsWith('/preview_hr_sheet_import'));assert.equal(result.file_sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(f.calls.at(-1).data.p_report_totals,null);
 assert.equal((await f.gateway(request({...data,action:'commit',complete:true,previous_import_id:null}))).status,200);
 const commit=f.calls.at(-1);assert(commit.url.endsWith('/commit_hr_sheet_import_from_gateway'));assert.deepEqual(commit.data.p_rows,[{...parsed,reported_total_cents:undefined}].map(({reported_total_cents,...row})=>row));assert.equal(Object.keys(commit.data.p_rows[0]).length,13);assert.equal(commit.data.p_report_totals,null);assert.equal(commit.data.p_file_base64,data.file_base64);assert.equal(commit.data.p_user_id,uid);assert.equal(f.loaded(),2);
});
test('RH XLSX financial formula results and footer are parsed from the original again for preview and commit',async()=>{
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Folha sintética');
 sheet.addRows([['FILIAL','ADMISSAO','ANIVERSARIO','Salário Folha','VT TOTAL','Salário recebido','Adiantamento','Ajuda de Custo','Total','SETOR','Funcionário'],
  ['Unidade sintética',46000,39000,2000,100,1500,400,200,{formula:'SUM(E2:H2)',result:2200},'OPERAÇÃO','Colaborador sintético'],
  ['Unidade sintética',null,39001,3000,0,1500,1500,0,{formula:'SUM(E3:H3)',result:3000},'SOCIO','Sócio sintético'],
  [null,null,null,{formula:'SUM(D2:D3)',result:5000},{formula:'SUM(E2:E3)',result:100},{formula:'SUM(F2:F3)',result:3000},{formula:'SUM(G2:G3)',result:1900},{formula:'SUM(H2:H3)',result:200},{formula:'SUM(I2:I3)',result:5200}]]);
 const bytes=Buffer.from(await book.xlsx.writeBuffer()),encoded=bytes.toString('base64');
 const expectedTotals={source_row:4,salary_base_cents:500000,payroll_salary_cents:300000,transport_cents:10000,advance_cents:190000,cost_allowance_cents:20000,total_cents:520000};
 const f=fixture({hrPreview:data=>({row_count:data.p_rows.length,previous_import_id:null,summary:{total_formula_version:'rh-reported-total-v1',total_cents:data.p_report_totals.total_cents},rows:data.p_rows.map(row=>({...row,reported_total_cents:row.total_cents}))}),loadWorkbook:async buffer=>{
  const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(buffer);const matrix=[];
  for(let line=1;line<=loaded.worksheets[0].rowCount;line++)matrix.push(loaded.worksheets[0].getRow(line).values.slice(1));
  assert.equal(matrix[1][8].result,2200);assert.equal(matrix[3][3].result,5000);
  return{matrix,excel1904:false};
 }});
 const data={action:'preview',mode:'hr',reference_date:'2026-10-19',file_name:'folha-sintetica.xlsx',file_base64:encoded};
 const response=await f.gateway(request(data)),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));
 assert.equal(result.format_version,4);assert.equal(result.rows.length,2);assert.equal(result.preview.row_count,2);assert.deepEqual(result.rows.map(row=>row.source_row),[2,3]);
 assert.equal(result.rows[0].salary_base_cents,200000);assert.equal(result.rows[0].total_cents,220000);assert.equal(result.rows[1].salary_base_cents,300000);assert.equal(result.rows[1].total_cents,300000);
 assert.equal(result.preview.summary.total_cents,520000);assert.notEqual(result.preview.summary.total_cents,1020000);
 assert.equal(result.file_sha256,createHash('sha256').update(bytes).digest('hex'));
 const preview=f.calls.at(-1);assert(preview.url.endsWith('/preview_hr_sheet_import'));assert.deepEqual(preview.data.p_report_totals,expectedTotals);assert(preview.data.p_rows.every(row=>Object.keys(row).length===13));
 assert.equal((await f.gateway(request({...data,action:'commit',previous_import_id:null,complete:true}))).status,200);
 const commit=f.calls.at(-1);assert(commit.url.endsWith('/commit_hr_sheet_import_from_gateway'));assert.deepEqual(commit.data.p_report_totals,expectedTotals);assert.deepEqual(commit.data.p_rows,preview.data.p_rows);
 assert.equal(commit.data.p_file_base64,encoded);assert.equal(commit.data.p_file_sha256,result.file_sha256);assert.equal(commit.data.p_user_id,uid);assert.equal(commit.data.p_session_id,session);assert.equal(commit.headers.Authorization,'Bearer server-only-key');assert.equal(f.loaded(),2);
 for(const spoof of [{report_totals:expectedTotals},{p_report_totals:expectedTotals},{totals:expectedTotals}]){
  const denied=await f.gateway(request({...data,...spoof}));assert.equal(denied.status,400);assert.equal(f.loaded(),2);
 }
});
test('RH rejects a stale formula contract returned by the database without exposing its rows',async()=>{
 const source='FILIAL;SETOR;FUNCIONÁRIO;Salário Folha;Salário recebido;Total\r\nA;OPERAÇÃO;Pessoa sintética;2.000,00;1.500,00;1.500,00';
 const f=fixture({hrPreview:data=>({row_count:1,previous_import_id:null,summary:{total_formula_version:'rh-five-fields-v1'},rows:data.p_rows})});
 const response=await f.gateway(request({action:'preview',mode:'hr',reference_date:'2026-10-19',file_name:'hr.csv',file_base64:Buffer.from(source).toString('base64')}));
 assert.equal(response.status,503);assert(!(await response.text()).includes('Pessoa sintética'));
});
test('RH CSV accepts 5000 people with the maximum header preamble and final totals without raising the person limit',async()=>{
 const header='FILIAL;ADMISSAO;ANIVERSARIO;Salário Folha;VT TOTAL;Salário recebido;Adiantamento;Ajuda de Custo;Total;SETOR;Funcionário';
 const people=Array.from({length:5000},(_,index)=>`Unidade sintética;;;2,00;0,00;1,00;0,00;0,00;1,00;OPERAÇÃO;Pessoa sintética ${index+1}`);
 const footer=';;;10.000,00;0,00;5.000,00;0,00;0,00;5.000,00';
 const source=[...Array(19).fill(''),header,...people,footer].join('\r\n');
 const f=fixture(),data={action:'preview',mode:'hr',reference_date:'2026-10-19',file_name:'rh-limite-sintetico.csv',file_base64:Buffer.from(source).toString('base64')};
 const response=await f.gateway(request(data)),result=await response.json();assert.equal(response.status,200,JSON.stringify(result.error));
 assert.equal(result.rows.length,5000);assert.equal(result.rows[0].source_row,21);assert.equal(result.rows.at(-1).source_row,5020);
 assert.equal(f.calls.at(-1).data.p_report_totals.source_row,5021);assert.equal(f.calls.at(-1).data.p_report_totals.total_cents,500000);
 const tooMany=source.replace(footer,people[0]+'\r\n'+footer),blocked=fixture();
 assert.equal((await blocked.gateway(request({...data,file_base64:Buffer.from(tooMany).toString('base64')}))).status,422);assert.equal(blocked.calls.length,2);
});
