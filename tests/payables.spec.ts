import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { parseCsv, validatePayableRows, isChequeNumberHeader, readPayableChequeCell } from '../src/lib/payables-parser.mjs';

const project='https://sjimddcqgrsauzvffcol.supabase.co';
async function setup(page:Page, options:{ director?:boolean; stale?:boolean; precision?:boolean; cheque?:boolean }={}) {
  const id='10000000-0000-4000-8000-000000000001'; const role=options.director?'diretor':'gerente_geral';
  const permissions=['painel','caixa','contas_pagar','importar_bases'].map(resource=>({resource,action:'read'}));
  if(!options.director)permissions.push({resource:'contas_pagar',action:'import'});
  const access={profile:{id,username:'UsuarioTeste',display_name:'Pessoa Teste',role_key:role,enabled:true},permissions,collector_id:null};
  const claims={sub:id,session_id:'20000000-0000-4000-8000-000000000001',exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),role:'authenticated'};
  const token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify(claims)).toString('base64url'),'synthetic-test-only'].join('.');
  const user={id,aud:'authenticated',role:'authenticated',email:'synthetic@test.invalid',created_at:new Date().toISOString(),app_metadata:{},user_metadata:{}};
  const title={id:'30000000-0000-4000-8000-000000000001',scope:'grupo-consolidado',source_key:'synthetic-stable',entry_number:'14',description:'Fornecedor sintético',due_date:'2026-10-16',amount_cents:123456,source_status:options.cheque?'CHEQUE':'ABERTO',...(options.cheque?{cheque_number:'000719'}:{}),plan:'ENERGIA',bank_account:'Bradesco',branch:'3',issued_on:'2026-10-01',macro:'FIXO',status:'NEW',settled_at:null};
  if(options.precision){title.amount_cents=Number.MAX_SAFE_INTEGER;title.description='=SYNTHETIC()';}
  const seen:{ commits:any[]; previews:any[]; queries:string[] }={commits:[],previews:[],queries:[]}; let imported=false;
  await page.route(`${project}/**`,async route=>{
    const req=route.request(),url=new URL(req.url()); const body=req.postDataJSON();
    const headers={'access-control-allow-origin':'http://127.0.0.1:4173','access-control-allow-headers':'apikey,content-type,authorization,x-client-info,prefer','access-control-allow-methods':'GET,POST,OPTIONS','access-control-expose-headers':'content-range'};
    const reply=(json:any,status=200,count?:number)=>route.fulfill({status,headers:{...headers,...(count!==undefined?{'content-range':count?`0-${count-1}/${count}`:'*/0'}:{})},json});
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
    if(url.pathname==='/functions/v1/auth-gateway')return reply({session:{access_token:token,refresh_token:'synthetic-refresh',expires_in:3600,token_type:'bearer'},access});
    if(url.pathname==='/auth/v1/user')return reply(user);
    if (url.pathname === '/rest/v1/rpc/receivables_management_summary') return reply({ code: 'PGRST202' }, 404);
    if(url.pathname==='/rest/v1/rpc/current_access')return reply(access);
    if(url.pathname==='/rest/v1/rpc/payables_management_summary')return reply({code:'PGRST202'},404);
  if(['/rest/v1/payable_review_titles','/rest/v1/payable_financial_titles'].includes(url.pathname))return reply({code:'PGRST205'},404);
    if(['/rest/v1/rpc/get_payable_payment_accounts','/rest/v1/rpc/payable_payment_summary','/rest/v1/rpc/list_payable_payments','/rest/v1/rpc/get_payables_revision','/rest/v1/rpc/get_payable_month_status','/rest/v1/rpc/payables_month_status','/rest/v1/rpc/list_payable_month_closures'].includes(url.pathname))return reply({code:'PGRST202'},404);
    if(url.pathname==='/rest/v1/rpc/payables_forecast')return reply({code:'PGRST202'},404);
    if(url.pathname==='/rest/v1/rpc/cash_position')return reply({accounts:[],total_cents:null,reported_accounts:0,expected_accounts:11,latest_position_date:null});
    if(url.pathname==='/rest/v1/rpc/current_stock')return reply({value_cents:null,reference_date:null,source:null});
    if(url.pathname==='/rest/v1/rpc/payables_summary')return reply({open_cents:123456,overdue_cents:0,period_cents:123456,active_count:1,latest_import_at:imported?new Date().toISOString():null});
    if(url.pathname==='/rest/v1/rpc/receivables_summary')return reply({open_cents:0,overdue_cents:0,period_cents:0,active_count:0,pending_count:0,unassigned_count:0,received_period_cents:0,latest_import_at:null,overdue_bps:null,overdue_comlurb_cents:null});
    if(url.pathname==='/rest/v1/director_positions')return reply([],200,0);
    if(url.pathname==='/rest/v1/payable_macros')return reply([{name:'FIXO'},{name:'VARIÁVEL'}],200,2);
    if(url.pathname==='/rest/v1/payable_plan_mappings')return reply([],200,0);
    if(url.pathname==='/rest/v1/payable_imports')return reply(imported?[{id:'40000000-0000-4000-8000-000000000001',file_name:'cp.csv',created_at:'2026-10-15T12:00:00Z',row_count:1,new_count:1,open_count:0,settled_count:0}]:[],200,imported?1:0);
    if(url.pathname==='/rest/v1/payable_titles'){seen.queries.push(url.search);return reply(url.searchParams.get('status')==='eq.SETTLED_IMPORT'?[]:[title],200,url.searchParams.get('status')==='eq.SETTLED_IMPORT'?0:1);}
    if(url.pathname==='/functions/v1/payables-import'){
      if(body.action==='preview') {
        seen.previews.push(body); const bytes=Buffer.from(body.file_base64,'base64'); let matrix:unknown[][];
        if(body.file_name.endsWith('.csv'))matrix=parseCsv(bytes.toString('utf8'));
        else {const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);const sheet=workbook.worksheets[0];const chequeColumns:number[]=[];sheet.getRow(1).eachCell((cell,column)=>{if(isChequeNumberHeader(cell.value))chequeColumns.push(column);});matrix=[];sheet.eachRow((row,index)=>{const values=(row.values as unknown[]).slice(1);if(index>1)for(const column of chequeColumns){const cell=row.getCell(column);values[column-1]=readPayableChequeCell(cell.value,cell.numFmt);}matrix.push(values);});}
        const parsed=validatePayableRows(matrix); return reply({rows:parsed.rows,file_sha256:createHash('sha256').update(bytes).digest('hex'),preview:{mode:'forecast',previous_import_id:null,row_count:parsed.rows.length,new_count:1,open_count:0,settled_count:0}});
      }
      seen.commits.push(body);if(options.stale)return reply({code:'40001',error:'private SQL details'},409);imported=true;return reply({import_id:'40000000-0000-4000-8000-000000000001',mode:'forecast',row_count:1,new_count:1,open_count:0,settled_count:0});
    }
    throw new Error(`Unexpected offline request ${req.method()} ${url.pathname}`);
  });
  await page.goto('/');await page.getByLabel('Usuário',{exact:true}).fill('UsuarioTeste');await page.getByLabel('Senha',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'Entrar na Central'}).click();await expect(page.getByRole('button',{name:'Sair',exact:false})).toBeVisible();
  return seen;
}
const csv='Nº Lançamento;Histórico;Vencimento;Valor;Plano de Contas;Filial\r\n14;Fornecedor sintético;16/10/2026;1.234,56;ENERGIA;3';
async function analyze(page:Page,content=csv) {
  await page.getByRole('navigation').getByRole('button',{name:'Importar Bases',exact:true}).click();
  await page.getByLabel('Relatório de previsões de Contas a Pagar',{exact:true}).setInputFiles({name:'cp.csv',mimeType:'text/csv',buffer:Buffer.from(content)});
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Analisar arquivo',exact:true}).click();
}
test('previsões exigem conferência e classificação, preservando títulos ausentes sem criar pagamentos',async({page})=>{
  const seen=await setup(page);await analyze(page);
  await expect(page.getByRole('heading',{name:'Conferência antes da importação'})).toBeVisible();
  const commit=page.getByRole('button',{name:'Atualizar previsões'});await expect(commit).toBeDisabled();
  await page.getByLabel('Macro para ENERGIA').selectOption('FIXO');await expect(commit).toBeEnabled();
  page.once('dialog',dialog=>{expect(dialog.message()).toContain('Os títulos ausentes permanecem na base');expect(dialog.message()).toContain('Nenhum pagamento será criado por ausência');expect(dialog.message()).not.toContain('serão QUITADOS');return dialog.accept();});await commit.click();
  await expect(page.getByRole('status')).toContainText('Importação concluída: 1 títulos');
  expect(seen.commits).toHaveLength(1);expect(seen.commits[0].mappings).toEqual({ENERGIA:'FIXO'});expect(seen.commits[0].complete).toBe(true);expect(seen.commits[0].mode).toBe('forecast');expect(seen.previews[0].mode).toBe('forecast');expect(seen.commits[0]).not.toHaveProperty('p_rows');expect(seen.commits[0]).not.toHaveProperty('file_sha256');expect(Buffer.from(seen.commits[0].file_base64,'base64').toString('utf8')).toBe(csv);
  await expect(page.getByRole('cell',{name:'cp.csv',exact:true})).toBeVisible();
});
test('linha inválida bloqueia toda importação e informa linha/coluna sem enviar preview',async({page})=>{
  const seen=await setup(page);await analyze(page,csv.replace('16/10/2026','31/02/2026'));
  await expect(page.getByRole('alert')).toContainText('Nenhum dado foi alterado');await expect(page.getByRole('cell',{name:'Data inexistente.'})).toBeVisible();
  expect(seen.previews).toHaveLength(0);expect(seen.commits).toHaveLength(0);
});
test('XLSX real com data Excel e valor numérico passa análise isolada e mantém centavos exatos',async({page})=>{
  const seen=await setup(page);const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('CP');
  sheet.addRow(['Nº Lançamento','Histórico','Vencimento','Valor','Plano de Contas','Filial']);sheet.addRow(['14','Fornecedor sintético',new Date('2026-10-16T00:00:00Z'),1234.56,'ENERGIA','3']);sheet.getCell('C2').numFmt='dd/mm/yyyy';
  const bytes=await workbook.xlsx.writeBuffer();await page.getByRole('navigation').getByRole('button',{name:'Importar Bases',exact:true}).click();
  await page.getByLabel('Relatório de previsões de Contas a Pagar',{exact:true}).setInputFiles({name:'cp.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(bytes)});
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Analisar arquivo',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Conferência antes da importação'})).toBeVisible();await expect(page.getByRole('table',{name:/Prévia dos títulos/}).getByRole('cell',{name:'R$ 1.234,56',exact:true})).toBeVisible();expect(seen.previews).toHaveLength(1);
  expect(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)}))).toEqual({local:[],session:[]});
});
test('base alterada desde preview exige reanálise e não mostra sucesso',async({page})=>{
  await setup(page,{stale:true});await analyze(page);await page.getByLabel('Macro para ENERGIA').selectOption('FIXO');page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Atualizar previsões'}).click();
  await expect(page.getByRole('alert')).toContainText('A base mudou desde a análise');await expect(page.getByRole('heading',{name:'Conferência antes da importação'})).toHaveCount(0);await expect(page.getByText('private SQL details')).toHaveCount(0);
});
test('diretor consulta CP e filtros chegam ao banco sem receber botão de importação',async({page})=>{
  const seen=await setup(page,{director:true});await page.getByRole('navigation').getByRole('button',{name:'Contas a Pagar',exact:true}).click();
  await expect(page.getByRole('cell',{name:'Fornecedor sintético',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Ir para Importar Bases'})).toHaveCount(0);
  await page.getByLabel('Pesquisar histórico / favorecido').fill('Outro_%');await expect.poll(()=>seen.queries.some(query=>new URLSearchParams(query).get('description')==='ilike.%Outro\\_\\%%')).toBe(true);
  await page.locator('#payables-status').selectOption('SETTLED_IMPORT');await expect(page.getByText('Nenhum título para os filtros selecionados.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Limpar filtros'}).click();await expect(page.getByRole('cell',{name:'Fornecedor sintético',exact:true})).toBeVisible();
});
test('moeda mantém centavo extremo e CSV exportado protege fórmulas sem perder precisão',async({page})=>{
  await setup(page,{director:true,precision:true});await page.getByRole('navigation').getByRole('button',{name:'Contas a Pagar',exact:true}).click();
  await expect(page.getByRole('cell',{name:'R$ 90.071.992.547.409,91',exact:true})).toBeVisible();
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Baixar CSV dos filtros'}).click();const download=await pending;const path=await download.path();expect(path).not.toBeNull();
  const contents=await readFile(path!,'utf8');expect(contents).toContain('"90071992547409,91"');expect(contents).toContain('"\'=SYNTHETIC()"');
});


test('ERP XLSX maps account separately from cost plan and previews the original civil dates before classification', async ({ page }) => {
  const seen = await setup(page); const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('CP');
  sheet.addRow(['Lançamento', 'Histórico', 'Plano cp - Conta: nome', 'Plano cc - Conta: nome', 'Emissão: valor do lançamento', 'Emissão: data', 'Vencimento: data', 'Filial', 'Situação', 'Cheque: número']);
  sheet.addRow(['ERP-TESTE-1', 'Fornecedor sintético do modelo', 'PLANO ERP SINTÉTICO', 'BANCO CONTA SINTÉTICA', 123.45, new Date('2026-10-01T15:03:00Z'), new Date('2026-10-17T00:00:00Z'), 'FILIAL SINTÉTICA', 'CHEQUE', 27]);
  sheet.getCell('J2').numFmt = '000000';
  sheet.getCell('F2').numFmt = 'dd/mm/yyyy hh:mm'; sheet.getCell('G2').numFmt = 'dd/mm/yyyy hh:mm';
  const bytes = await workbook.xlsx.writeBuffer();
  await page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true }).click();
  await page.getByLabel('Relatório de previsões de Contas a Pagar', { exact: true }).setInputFiles({ name: 'modelo-erp.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) });
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click();
  const preview = page.getByRole('table', { name: /Prévia dos títulos/ });
  await expect(preview.getByRole('cell', { name: 'BANCO CONTA SINTÉTICA', exact: true })).toBeVisible();
  await expect(preview.getByRole('cell', { name: 'PLANO ERP SINTÉTICO', exact: true })).toBeVisible();
  await expect(preview.getByRole('cell', { name: '01/10/2026', exact: true })).toBeVisible();
  await expect(preview.getByRole('cell', { name: '17/10/2026', exact: true })).toBeVisible();
  await expect(preview.getByRole('cell', { name: 'R$ 123,45', exact: true })).toBeVisible();
  await expect(preview.getByRole('cell', { name: 'CHEQUE', exact: true })).toBeVisible();
  await expect(preview.getByRole('cell', { name: '000027', exact: true })).toBeVisible();
  await expect(preview.getByRole('cell', { name: 'ERP-TESTE-1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Atualizar previsões' })).toBeDisabled();
  await page.getByLabel('Macro para PLANO ERP SINTÉTICO').selectOption('FIXO');
  await expect(page.getByRole('button', { name: 'Atualizar previsões' })).toBeEnabled();
  expect(seen.previews).toHaveLength(1); expect(seen.commits).toHaveLength(0);
  expect(seen.previews[0]).not.toHaveProperty('rows');
});


test('cheque numbers have their own title column and CSV preserves leading zeros without using the entry number', async ({ page }) => {
  await setup(page, { director: true, cheque: true });
  await page.getByRole('navigation').getByRole('button', { name: 'Contas a Pagar', exact: true }).click();
  const table = page.locator('section[aria-labelledby="payables-title"] table');
  await expect(table.getByRole('columnheader', { name: 'Nº cheque', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '000719', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '14', exact: true })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Baixar CSV dos filtros', exact: true }).click();
  const contents = await readFile((await (await pending).path())!, 'utf8');
  expect(contents).toContain('"Nº cheque"'); expect(contents).toContain('"000719"'); expect(contents).toContain('"14"');
});
