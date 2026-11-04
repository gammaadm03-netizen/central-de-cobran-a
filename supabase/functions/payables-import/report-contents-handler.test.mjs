import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPayablesGateway } from './handler.mjs';
import { hasPaymentReportHeader, validContentsPreview, validContentsCommit } from './report-contents-reconciliation.mjs';

const USER='10000000-0000-4000-8000-000000000001',SESSION='20000000-0000-4000-8000-000000000001';
const IMPORT='30000000-0000-4000-8000-000000000001',REPORT='40000000-0000-4000-8000-000000000001';
const REQUEST='50000000-0000-4000-8000-000000000001',TITLE='60000000-0000-4000-8000-000000000001';
const ORIGIN='https://central.example.invalid',BASE='https://project.example.invalid';
const TOKEN=`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({sub:USER,session_id:SESSION})).toString('base64url')}.verified`;
const HEADER='Lançamento;Histórico;Vencimento;Valor;Plano de Contas;Filial;Emissão;Banco;Situação;Cheque: número';
const LINE='TESTE-001;Fornecedor sintético;20/11/2026;100,00;COMPRA DE MERCADORIA;Filial sintética;01/10/2026;Banco previsto;PENDENTE;';
const CSV=HEADER+'\r\n'+LINE+'\r\n',encode=text=>Buffer.from(text).toString('base64');
const key=row=>JSON.stringify([row.branch.toUpperCase(),row.entry_number.toUpperCase()]);
const body=(extra={})=>({action:'preview',mode:'open_status',status_report_version:'065',report_kind:'ALL',report_contents:'FULL_OPEN',file_name:'sintetico.csv',file_base64:encode(CSV),mappings:{},resolution_choices:{},...extra});
const commit=(extra={})=>body({action:'commit',complete:true,previous_import_id:null,previous_financial_revision:'065:17',expected_report_date:'2026-11-04',request_id:REQUEST,...extra});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const capabilities={status_from_report:true,status_report_version:'065',report_contents_required:true};
function setup(options={}) {
 const calls=[],permissions=[...['read','write','import'].map(action=>({resource:'contas_pagar',action})),{resource:'importar_bases',action:'read'}];
 const handler=createPayablesGateway({now:()=>new Date(options.now??'2026-11-04T13:00:00Z'),env:name=>({ALLOWED_ORIGINS:ORIGIN,SUPABASE_URL:BASE,SUPABASE_ANON_KEY:'public-synthetic',SUPABASE_SERVICE_ROLE_KEY:'service-synthetic'})[name],
  loadWorkbook:async()=>{throw new Error('No synthetic XLSX decoding');},fetch:async(url,init)=>{
   const path=new URL(url).pathname,data=init.body?JSON.parse(init.body):null;calls.push({path,data,init});
   if(path==='/auth/v1/user')return json({id:USER});
   if(path==='/rest/v1/rpc/current_access')return json({profile:{id:USER,enabled:true},permissions:options.permissions??permissions});
   if(path==='/rest/v1/rpc/payables_import_capabilities')return json(options.capabilities??capabilities);
   if(!['/rest/v1/rpc/preview_payables_status_contents_report','/rest/v1/rpc/commit_payables_status_contents_report_from_gateway'].includes(path))throw new Error('Unexpected route '+path);
   if(options.rpcError)return json(options.rpcError,409);
   const paid=data.p_report_contents==='PAID_STATUS',rows=data.p_rows;
   let preview={mode:'open_status',status_report_version:'065',status_only:true,report_kind:'ALL',report_contents:data.p_report_contents,report_date:'2026-11-04',
    previous_import_id:paid?IMPORT:null,financial_revision:'065:17',rows,source_row_count:rows.length,row_count:rows.length,new_count:paid?0:rows.length,open_count:paid?rows.length:0,
    changed_count:0,marked_paid_count:paid?rows.length:0,marked_paid_cents:paid?rows.reduce((s,r)=>s+r.amount_cents,0):0,reopened_count:0,
    position_count:paid?3-rows.length:rows.length,previous_position_count:paid?3:0,removed_from_position_count:paid?rows.length:0,
    requires_large_reduction_confirmation:false,large_reduction_confirmed:data.p_confirm_large_reduction,large_reduction_problem:null,
    paid_already_closed_keys:[],paid_already_closed_count:0,paid_unknown_keys:[],baseline_only:!paid,baseline_origin:paid?'PREVIOUS_REPORT':'FIRST_REPORT',
    status_actions:paid?rows.map(r=>({kind:'PAID',title_id:TITLE,source_key:key(r),amount_cents:r.amount_cents,source_amount_cents:r.amount_cents})):[],
    exceptions:[],errors:[],can_commit:true,unmapped_plans:[],macro_options:['COMPRA DE MERCADORIA','NÃO CLASSIFICADO'],rounding_adjustments:data.p_rounding_adjustments,empty_report_confirmed:data.p_empty_report_confirmed};
   if(options.preview)preview=options.preview(preview,data);
   if(path.includes('/preview_')){assert.equal(init.headers.Authorization,`Bearer ${TOKEN}`);return json(preview);}
   assert.equal(init.headers.Authorization,'Bearer service-synthetic');
   let result={...preview,request_id:data.p_request_id,report_id:REPORT,import_id:IMPORT,report_date:data.p_expected_report_date,updated_count:preview.changed_count,
    paid_count:0,payment_cents:0,payments_created:0,written_off_count:Object.keys(data.p_resolution_choices).length,idempotent:options.replay??false};
   delete result.rows;delete result.errors;delete result.can_commit;
   if(options.result)result=options.result(result,data);
   return json(result);
  }});
 return{calls,send:value=>handler(new Request(BASE+'/functions/v1/payables-import',{method:'POST',headers:{Origin:ORIGIN,Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify(value??body())}))};
}

test('065 requires explicit contents before decoding and never accepts client financial rows or rounded overrides',async()=>{
 for(const extra of[{report_contents:undefined},{report_contents:'OPEN_COMPLETE'},{report_contents:'UNKNOWN'},{rows:[]},{bank_mappings:{}},{rounding_adjustments:[]},{confirm_large_reduction:'true'},{report_contents:'PAID_STATUS',empty_report_confirmed:true},{report_contents:'PAID_STATUS',confirm_large_reduction:true}]){
  const app=setup(),response=await app.send(body({file_base64:'!',...extra}));assert.equal(response.status,400);assert.equal(app.calls.length,2);
 }
});

test('FULL_OPEN parses authoritative source bytes and keeps automatic value and maturity updates',async()=>{
 const app=setup(),response=await app.send();assert.equal(response.status,200);const result=await response.json(),sent=app.calls.at(-1).data;
 assert.equal(result.file_sha256,createHash('sha256').update(CSV).digest('hex'));assert.deepEqual(sent.p_rows,result.rows);
 assert.equal(sent.p_report_contents,'FULL_OPEN');assert.equal(sent.p_confirm_large_reduction,false);assert.equal(result.preview.position_count,1);
 assert(!Object.hasOwn(sent,'p_bank_mappings'));assert(!app.calls.some(c=>/open_status_report|unified_report|paid_import/.test(c.path)));
});

test('PAID_STATUS closes only listed source identities and can preserve a larger operational position',async()=>{
 const app=setup(),response=await app.send(body({report_contents:'PAID_STATUS'}));assert.equal(response.status,200);const p=(await response.json()).preview;
 assert.equal(p.row_count,1);assert.equal(p.previous_position_count,3);assert.equal(p.position_count,2);assert.equal(p.removed_from_position_count,1);
 assert.equal(p.status_actions[0].source_key,'["FILIAL SINTÉTICA","TESTE-001"]');assert.equal(p.marked_paid_count,1);assert.equal(p.changed_count,0);assert.equal(p.reopened_count,0);
});

test('payment-report headers block FULL_OPEN while PAID_STATUS imports only status without creating payment facts',async()=>{
 const source=HEADER+';Quitação: data do pagamento;Quitação: valor pago\r\n'+LINE+';03/11/2026;100,00\r\n';
 const wrong=setup(),blocked=await wrong.send(body({file_base64:encode(source)}));assert.equal(blocked.status,422);assert.equal((await blocked.json()).errors[0].column,'Abrangência do relatório');assert.equal(wrong.calls.length,2);
 const paid=setup(),ok=await paid.send(commit({report_contents:'PAID_STATUS',file_base64:encode(source)}));assert.equal(ok.status,200);const r=await ok.json(),sent=paid.calls.at(-1).data;
 assert.equal(r.payments_created,0);assert.equal(r.payment_cents,0);assert.equal(sent.p_rows[0].amount_cents,10000);
 assert(!Object.hasOwn(sent.p_rows[0],'paid_on'));assert(!Object.hasOwn(sent,'p_bank_mappings'));assert.equal(sent.p_file_base64,encode(source));
 for(const h of['Data do pagamento','Quitação: valor pago','Quitação: data do recebimento',{richText:[{text:'Quitação: '},{text:'data do pagamento'}]}])assert.equal(hasPaymentReportHeader([h]),true);
 assert.equal(hasPaymentReportHeader(['Forma de quitação','Plano cc - Conta: nome']),false);
});

test('a sharp decline cannot commit until its exact technical preview is explicitly confirmed',async()=>{
 const warning='Confirme que o arquivo contém todos os títulos em aberto, mesmo com a redução indicada.';
 const app=setup({preview:(p,d)=>({...p,baseline_only:false,baseline_origin:'PREVIOUS_REPORT',previous_position_count:100,removed_from_position_count:99,
  requires_large_reduction_confirmation:true,large_reduction_problem:d.p_confirm_large_reduction?null:warning,
  can_commit:d.p_confirm_large_reduction,errors:d.p_confirm_large_reduction?[]:[{line:0,column:'Abrangência do relatório',code:'LARGE_REDUCTION_CONFIRMATION',problem:warning,correction:'Confira o relatório completo.'}]})});
 const pending=await app.send();assert.equal(pending.status,200);assert.equal((await pending.json()).preview.can_commit,false);
 const confirmed=await app.send(commit({confirm_large_reduction:true}));assert.equal(confirmed.status,200);assert.equal((await confirmed.json()).large_reduction_confirmed,true);assert.equal(app.calls.at(-1).data.p_confirm_large_reduction,true);
 const bad=setup({preview:p=>({...p,previous_position_count:100,removed_from_position_count:99,requires_large_reduction_confirmation:false})});assert.equal((await bad.send()).status,503);
});

test('unknown listed paid titles are review errors and never become new open titles',async()=>{
 const app=setup({preview:p=>({...p,new_count:1,open_count:0,marked_paid_count:0,marked_paid_cents:0,position_count:3,removed_from_position_count:0,status_actions:[],paid_unknown_keys:[key(p.rows[0])],
  can_commit:false,errors:[{line:1,column:'Título',problem:'Título não encontrado na base.',correction:'Confira a filial e o lançamento.'}]})});
 const response=await app.send(body({report_contents:'PAID_STATUS'}));assert.equal(response.status,200);const p=(await response.json()).preview;
 assert.equal(p.can_commit,false);assert.equal(p.new_count,1);assert.equal(p.position_count,3);
 const omitted=setup({preview:p=>({...p,can_commit:true,new_count:1,open_count:0,status_actions:[],marked_paid_count:0,marked_paid_cents:0,paid_unknown_keys:[key(p.rows[0])]})});
 assert.equal((await omitted.send(body({report_contents:'PAID_STATUS'}))).status,503);
});

test('PAID_STATUS can acknowledge an already-closed source title without touching its financial history',async()=>{
 const app=setup({preview:p=>({...p,status_actions:[],marked_paid_count:0,marked_paid_cents:0,paid_already_closed_keys:[key(p.rows[0])],paid_already_closed_count:1})});
 assert.equal((await app.send(commit({report_contents:'PAID_STATUS'}))).status,200);
 const omitted=setup({preview:p=>({...p,status_actions:[],marked_paid_count:0,marked_paid_cents:0})});
 assert.equal((await omitted.send(body({report_contents:'PAID_STATUS'}))).status,503);
});

test('a paid status action uses the current nominal reference without overwriting changed source amounts',async()=>{
 const preview=p=>({...p,marked_paid_cents:9000,status_actions:[{...p.status_actions[0],amount_cents:9000}]});
 const app=setup({preview});assert.equal((await app.send(body({report_contents:'PAID_STATUS'}))).status,200);
 const corrupt=setup({preview:p=>({...preview(p),status_actions:[{...preview(p).status_actions[0],source_amount_cents:1}]})});
 assert.equal((await corrupt.send(body({report_contents:'PAID_STATUS'}))).status,503);
});

test('065 rejects mismatched type, position, source membership and hidden financial side effects',async()=>{
 for(const mutate of[p=>({...p,report_contents:'FULL_OPEN'}),p=>({...p,position_count:3}),p=>({...p,removed_from_position_count:4}),p=>({...p,source_row_count:2}),
  p=>({...p,status_actions:[{...p.status_actions[0],source_key:'["FILIAL SINTÉTICA","OUTRO"]'}]}),p=>({...p,reopened_count:1}),p=>({...p,changed_count:1}),p=>({...p,payments_created:1})]){
  const app=setup({preview:mutate});assert.equal((await app.send(body({report_contents:'PAID_STATUS'}))).status,503);
 }
 for(const mutate of[r=>({...r,payment_cents:1}),r=>({...r,paid_count:1}),r=>({...r,position_count:0}),r=>({...r,new_count:1,open_count:0}),r=>({...r,report_contents:'FULL_OPEN'}),r=>({...r,paid_unknown_keys:['["FILIAL SINTÉTICA","TESTE-001"]']})]){
  const app=setup({result:mutate});assert.equal((await app.send(commit({report_contents:'PAID_STATUS'}))).status,503);
 }
});

test('065 rounds each source title on the service and preserves the original bytes and audit adjustments',async()=>{
 const source=CSV.replace('100,00;','3.122,935;'),app=setup(),response=await app.send(commit({file_base64:encode(source)}));assert.equal(response.status,200);
 const result=await response.json(),sent=app.calls.at(-1).data;assert.equal(sent.p_rows[0].amount_cents,312294);
 assert.deepEqual(result.rounding_adjustments,[{line:2,original_amount:'3.122,935',amount_cents:312294}]);assert.equal(sent.p_file_base64,encode(source));
});

test('065 capability is explicit and older writers cannot bypass the report-content selection',async()=>{
 const absent=setup({capabilities:{status_from_report:true,status_report_version:'061'}}),response=await absent.send();assert.equal(response.status,409);assert.equal((await response.json()).code,'P0065');
 for(const extra of[{status_report_version:'061',report_contents:undefined},{mode:'daily',daily_report_version:'060',status_report_version:undefined,report_contents:undefined,bank_mappings:{}}]){
  const app=setup(),old=body(extra);for(const field of Object.keys(old))if(old[field]===undefined)delete old[field];
  const r=await app.send(old);assert.equal(r.status,409);assert.equal((await r.json()).code,'P0065');assert(!app.calls.some(c=>/preview_|commit_/.test(c.path)));
 }
});

test('exact uncertain retry forwards the original type, protocol and date without a new preview',async()=>{
 const input=commit({report_contents:'PAID_STATUS'}),app=setup({now:'2026-11-05T13:00:00Z',replay:true});
 for(let n=0;n<2;n++){const r=await app.send(input);assert.equal(r.status,200);assert.equal((await r.json()).idempotent,true);}
 const writes=app.calls.filter(c=>/commit_/.test(c.path));assert.equal(writes.length,2);assert.deepEqual(writes[0].data,writes[1].data);
 assert.equal(writes[0].data.p_request_id,REQUEST);assert.equal(writes[0].data.p_expected_report_date,'2026-11-04');assert.equal(writes[0].data.p_report_contents,'PAID_STATUS');assert(!app.calls.some(c=>/preview_/.test(c.path)));
});

test('source parsing and all CP permissions remain required for either content type',async()=>{
 for(const contents of['FULL_OPEN','PAID_STATUS']){
  for(const source of[CSV+LINE,CSV.replace('Fornecedor sintético','=1+1'),CSV.replace('Valor;','Desconhecido;')]){const app=setup();assert.equal((await app.send(body({report_contents:contents,file_base64:encode(source)}))).status,422);assert.equal(app.calls.length,2);}
  const permissions=[...['read','write','import'].map(action=>({resource:'contas_pagar',action})),{resource:'importar_bases',action:'read'}];
  for(let i=0;i<permissions.length;i++){const app=setup({permissions:permissions.filter((_,index)=>index!==i)});assert.equal((await app.send(body({report_contents:contents,file_base64:'!'}))).status,403);assert.equal(app.calls.length,2);}
 }
});

test('unknown one-cent paid rows remain unknown instead of inventing an administrative closure',async()=>{
 const app=setup({preview:p=>({...p,new_count:1,open_count:0,status_actions:[],marked_paid_count:0,marked_paid_cents:0,position_count:3,removed_from_position_count:0,paid_unknown_keys:[key(p.rows[0])],can_commit:false,
  errors:[{line:1,column:'Título',problem:'Título não encontrado.',correction:'Confira a identidade.'}]})});
 const r=await app.send(body({report_contents:'PAID_STATUS',file_base64:encode(CSV.replace('100,00;','0,01;'))}));assert.equal(r.status,200);assert.deepEqual((await r.json()).preview.exceptions,[]);
});

test('known paid cent markers preserve current forecast maturity while requiring individual write-off approval',async()=>{
 const source=CSV.replace('100,00;','0,01;');
 const app=setup({preview:(p,d)=>{const selected=d.p_resolution_choices['row:1']?.action??null;return{...p,status_actions:[],marked_paid_count:0,marked_paid_cents:0,
  exceptions:[{key:'row:1',kind:'CENT',line:1,title_id:TITLE,branch:'Filial sintética',entry_number:'TESTE-001',description:'Fornecedor sintético',due_date:'2026-11-19',amount_cents:1,
   requires_resolution:true,allowed_actions:['WRITE_OFF'],selected_action:selected,problem:selected?null:'Confirme esta baixa individualmente, sem pagamento.',payment_remaining_cents:0}],
  can_commit:!!selected,errors:selected?[]:[{line:1,column:'Baixa sem pagamento',problem:'Confirme esta baixa individualmente, sem pagamento.',correction:'Confirme somente o marcador.'}]};}});
 const r=await app.send(body({report_contents:'PAID_STATUS',file_base64:encode(source)}));assert.equal(r.status,200);const checked=await r.json();assert.equal(checked.preview.can_commit,false);
 assert.equal(checked.rows[0].due_date,'2026-11-20');assert.equal(checked.preview.exceptions[0].due_date,'2026-11-19');
 const done=await app.send(commit({report_contents:'PAID_STATUS',file_base64:encode(source),resolution_choices:{'row:1':{action:'WRITE_OFF',reason:'Baixa individual do marcador administrativo confirmada.'}}}));
 assert.equal(done.status,200);const proof=await done.json();assert.equal(proof.written_off_count,1);assert.equal(proof.payment_cents,0);assert.equal(proof.payments_created,0);assert.equal(proof.marked_paid_count,0);
});

test('FULL_OPEN cent proofs still require exact source maturity and reject a different title date',async()=>{
 const source=CSV.replace('100,00;','0,01;'),app=setup({preview:p=>({...p,exceptions:[{
  key:'row:1',kind:'CENT',line:1,title_id:null,branch:'Filial sintética',entry_number:'TESTE-001',description:'Fornecedor sintético',due_date:'2026-11-19',amount_cents:1,
  requires_resolution:true,allowed_actions:['WRITE_OFF'],selected_action:null,problem:'Confirme a baixa individual.',payment_remaining_cents:0}],
  can_commit:false,errors:[{line:1,column:'Baixa sem pagamento',problem:'Confirme a baixa individual.',correction:'Confirme somente o marcador.'}]})});
 assert.equal((await app.send(body({file_base64:encode(source)}))).status,503);
});

test('shared pure proof guards are available for actual SQL parity validation',()=>{
 assert.equal(typeof validContentsPreview,'function');assert.equal(typeof validContentsCommit,'function');
});
