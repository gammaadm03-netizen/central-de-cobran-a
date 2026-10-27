import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { parseCsv, validatePayableRows, isChequeNumberHeader, readPayableChequeCell } from '../src/lib/payables-parser.mjs';

const project='https://sjimddcqgrsauzvffcol.supabase.co';
interface Options { director?:boolean; stale?:boolean; precision?:boolean; cheque?:boolean; administrative?:boolean; knownPlan?:boolean; missing?:boolean; uncertain?:boolean; legacyPreview?:boolean; ignoreChoices?:boolean; rejectChoices?:boolean }
const account = { id:'60000000-0000-4000-8000-000000000001', display_name:'Conta oficial sintética', company:'Empresa sintética', bank:'Banco sintético' };
const absentPaid = '50000000-0000-4000-8000-000000000001', absentWrittenOff = '50000000-0000-4000-8000-000000000002';
async function setup(page:Page, options:Options={}) {
  const id='10000000-0000-4000-8000-000000000001'; const role=options.director?'diretor':'gerente_geral';
  const permissions=['painel','caixa','contas_pagar','importar_bases'].map(resource=>({resource,action:'read'}));
  if(!options.director)permissions.push({resource:'contas_pagar',action:'import'},{resource:'contas_pagar',action:'write'});
  const access={profile:{id,username:'UsuarioTeste',display_name:'Pessoa Teste',role_key:role,enabled:true},permissions,collector_id:null};
  const claims={sub:id,session_id:'20000000-0000-4000-8000-000000000001',exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),role:'authenticated'};
  const token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify(claims)).toString('base64url'),'synthetic-test-only'].join('.');
  const user={id,aud:'authenticated',role:'authenticated',email:'synthetic@test.invalid',created_at:new Date().toISOString(),app_metadata:{},user_metadata:{}};
  const title={id:'30000000-0000-4000-8000-000000000001',scope:'grupo-consolidado',source_key:'synthetic-stable',entry_number:'14',description:'Fornecedor sintético',due_date:'2026-10-16',amount_cents:123456,source_status:options.cheque?'CHEQUE':'ABERTO',...(options.cheque?{cheque_number:'000719'}:{}),plan:'ENERGIA',bank_account:'Bradesco',branch:'3',issued_on:'2026-10-01',macro:'FIXO',status:'NEW',settled_at:null};
  if(options.precision){title.amount_cents=Number.MAX_SAFE_INTEGER;title.description='=SYNTHETIC()';}
  if(options.administrative)Object.assign(title,{financial_status:'ADMIN_WRITEOFF',paid_cents:0,outstanding_cents:0,overpaid_cents:0,administrative_writeoff_id:'70000000-0000-4000-8000-000000000001',administrative_writeoff_at:'2026-10-19T12:00:00Z',administrative_writeoff_by:id,administrative_writeoff_reason:'Baixa administrativa sintética confirmada',administrative_writeoff_import_id:'40000000-0000-4000-8000-000000000001',review_status:'BAIXADO_ADMINISTRATIVAMENTE',closing_eligible:false,closing_exclusion_reason:'ADMIN_WRITEOFF'});
  const seen={commits:[] as any[],previews:[] as any[],queries:[] as string[],ledger:[] as any[],writeoffs:[] as string[],financialWrites:[] as string[],remaining:new Map([[absentPaid,'OPEN'],[absentWrittenOff,'OPEN']])};
  const protocols = new Map<string, any>(); let imported=false,lastRows=1; let storedPlans:Record<string,string>={};
  await page.route(`${project}/**`,async route=>{
    const req=route.request(),url=new URL(req.url()); const body=req.postDataJSON();
    const headers={'access-control-allow-origin':'http://127.0.0.1:4173','access-control-allow-headers':'apikey,content-type,authorization,x-client-info,prefer','access-control-allow-methods':'GET,POST,OPTIONS','access-control-expose-headers':'content-range'};
    const reply=(json:any,status=200,count?:number)=>route.fulfill({status,headers:{...headers,...(count!==undefined?{'content-range':count?`0-${count-1}/${count}`:'*/0'}:{})},json});
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
    if(url.pathname==='/functions/v1/auth-gateway')return reply({session:{access_token:token,refresh_token:'synthetic-refresh',expires_in:3600,token_type:'bearer'},access});
    if(url.pathname==='/auth/v1/user')return reply(user);
    if(url.pathname==='/rest/v1/rpc/receivables_management_summary')return reply({code:'PGRST202'},404);
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
    if(url.pathname==='/rest/v1/payable_plan_mappings')return reply(Object.entries({... (options.knownPlan?{ENERGIA:'FIXO'}:{}),...storedPlans}).map(([plan,macro])=>({plan,macro})),200,0);
    if(url.pathname==='/rest/v1/payable_imports')return reply(imported?[{id:'40000000-0000-4000-8000-000000000001',file_name:'cp.csv',created_at:'2026-10-15T12:00:00Z',row_count:lastRows,new_count:lastRows,open_count:0,settled_count:0}]:[],200,imported?1:0);
    if(url.pathname==='/rest/v1/payable_titles'){seen.queries.push(url.search);return reply(url.searchParams.get('status')==='eq.SETTLED_IMPORT'?[]:[title],200,url.searchParams.get('status')==='eq.SETTLED_IMPORT'?0:1);}
    if(url.pathname==='/functions/v1/payables-import'){
      expect(body.mode).toBe('forecast'); expect(body.reconciliation_version).toBe('043'); expect(typeof body.full_report).toBe('boolean');
      const bytes=Buffer.from(body.file_base64,'base64'); let matrix:unknown[][];
      if(body.file_name.endsWith('.csv'))matrix=parseCsv(bytes.toString('utf8'));
      else {const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);const sheet=workbook.worksheets[0];const chequeColumns:number[]=[];sheet.getRow(1).eachCell((cell,column)=>{if(isChequeNumberHeader(cell.value))chequeColumns.push(column);});matrix=[];sheet.eachRow((row,index)=>{const values=(row.values as unknown[]).slice(1);if(index>1)for(const column of chequeColumns){const cell=row.getCell(column);values[column-1]=readPayableChequeCell(cell.value,cell.numFmt);}matrix.push(values);});}
      const parsed=validatePayableRows(matrix); if(parsed.errors.length)return reply({code:'22023',errors:parsed.errors},422);
      lastRows=parsed.rows.length;
      const items:any[]=parsed.rows.flatMap((row,index)=>row.amount_cents===1?[{key:`row:${index+1}`,kind:'CENT',line:index+1,title_id:null,branch:row.branch,entry_number:row.entry_number,description:row.description,due_date:row.due_date,amount_cents:1,source_amount_cents:1,already_written_off:false,allowed_actions:['WRITE_OFF']}]:[]);
      if(options.missing&&body.full_report)for(const [index,title_id]of[absentPaid,absentWrittenOff].entries())items.push({key:`title:${title_id}`,kind:'MISSING',line:null,title_id,branch:'3',entry_number:`AUSENTE-${index+1}`,description:`Título ausente sintético ${index+1}`,due_date:'2026-10-10',amount_cents:index?22222:11111,allowed_actions:['PAID','WRITE_OFF']});
      for(const item of items){
        const selected=options.ignoreChoices?null:body.resolution_choices?.[item.key];
        const valid=selected&&item.allowed_actions.includes(selected.action)&&typeof selected.reason==='string'&&selected.reason.trim()&&(selected.action!=='PAID'||/^\d{4}-\d{2}-\d{2}$/.test(selected.paid_on)&&Number.isSafeInteger(selected.amount_paid_cents)&&selected.amount_paid_cents>0&&selected.bank_account_id===account.id);
        item.selected_action=valid?selected.action:null; item.requires_resolution=!valid; item.problem=valid?null:'Escolha a conciliação deste título antes de importar.';
      }
      const errors=items.filter(item=>item.requires_resolution).map(item=>({line:item.line?item.line+1:0,column:'Conciliação',problem:item.problem,correction:'Confirme a baixa ou informe os dados efetivos do pagamento e valide novamente.'}));
      const preview:any={mode:'forecast',previous_import_id:null,row_count:parsed.rows.length,new_count:parsed.rows.length,open_count:0,settled_count:0,reconciliation_version:'043',financial_revision:'financial-0',full_report:body.full_report,reconciliation_items:items,resolution_errors:errors,can_commit:errors.length===0,bank_options:[account]};
      if(body.action==='preview'){
        seen.previews.push(body);
        if(options.rejectChoices&&Object.keys(body.resolution_choices??{}).length)return reply({code:'P0043',activation_required:false,error:'private SQL details'},409);
        if(options.legacyPreview){delete preview.reconciliation_version;delete preview.reconciliation_items;delete preview.financial_revision;}
        return reply({rows:parsed.rows,file_sha256:createHash('sha256').update(bytes).digest('hex'),preview});
      }
      seen.commits.push(body);
      if(protocols.has(body.request_id))return reply({...protocols.get(body.request_id),idempotent:true});
      if(options.stale)return reply({code:'40001',error:'private SQL details'},409);
      if(!preview.can_commit||!body.complete||!body.request_id||body.previous_financial_revision!=='financial-0')return reply({code:'P0043',activation_required:false,error:'private SQL details'},409);
      for(const [key,choice]of Object.entries(body.resolution_choices??{}) as [string,any][]){if(choice.action==='PAID'){seen.ledger.push({title_id:key.slice(6),...choice});seen.remaining.set(key.slice(6),'PAID');}else if(choice.action==='WRITE_OFF'){seen.writeoffs.push(key);if(key.startsWith('title:'))seen.remaining.set(key.slice(6),'WRITE_OFF');}}
      imported=true;storedPlans={...storedPlans,...body.mappings};
      const result={import_id:'40000000-0000-4000-8000-000000000001',request_id:body.request_id,mode:'forecast',row_count:parsed.rows.length,new_count:parsed.rows.length,open_count:0,settled_count:0,idempotent:false};protocols.set(body.request_id,result);
      if(options.uncertain&&seen.commits.length===1)return reply({code:'XX000',error:'private SQL details'},503);
      return reply(result);
    }
    if(req.method()!=='GET')seen.financialWrites.push(url.pathname);
    throw new Error(`Unexpected offline request ${req.method()} ${url.pathname}`);
  });
  await page.goto('/');await page.getByLabel('Usuário',{exact:true}).fill('UsuarioTeste');await page.getByLabel('Senha',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'Entrar na Central'}).click();await expect(page.getByRole('button',{name:'Sair',exact:false})).toBeVisible();
  return seen;
}
const csv='Nº Lançamento;Histórico;Vencimento;Valor;Plano de Contas;Filial\r\n14;Fornecedor sintético;16/10/2026;1.234,56;ENERGIA;3';
async function analyze(page:Page,content=csv,full=false) {
  await page.getByRole('navigation').getByRole('button',{name:'Importar Bases',exact:true}).click();
  await page.getByRole('radio',{name:full?'Relatório completo de títulos em aberto':'Somente novos títulos e atualizações',exact:true}).check();
  await page.getByLabel('Relatório de previsões de Contas a Pagar',{exact:true}).setInputFiles({name:'cp.csv',mimeType:'text/csv',buffer:Buffer.from(content)});
  await page.getByRole('checkbox',{name:'Confirmo o conteúdo do relatório e o tipo de importação selecionado.',exact:true}).check();await page.getByRole('button',{name:'Analisar arquivo',exact:true}).click();
}
async function validateChoices(page:Page) { await page.getByRole('button',{name:'Validar escolhas da importação',exact:true}).click(); await expect(page.getByRole('button',{name:'Analisando cópia…',exact:true})).toHaveCount(0); }
test('previsões exigem conferência e classificação, preservando títulos ausentes sem criar pagamentos',async({page})=>{
  const seen=await setup(page);await analyze(page);
  await expect(page.getByRole('heading',{name:'Conferência antes da importação'})).toBeVisible();
  const commit=page.getByRole('button',{name:'Importar e conciliar títulos'});await expect(commit).toBeDisabled();
  await page.getByLabel('Macro para ENERGIA').selectOption('FIXO');await expect(commit).toBeDisabled();await validateChoices(page);await expect(commit).toBeEnabled();
  page.once('dialog',dialog=>{expect(dialog.message()).toContain('Somente novos títulos e atualizações');expect(dialog.message()).toContain('Pagamentos efetivos informados: 0');expect(dialog.message()).toContain('Somente baixado não cria pagamento nem realizado');return dialog.accept();});await commit.click();
  await expect(page.getByRole('status')).toContainText('Importação concluída: 1 título(s) conferido(s)');
  expect(seen.commits).toHaveLength(1);expect(seen.commits[0].mappings).toEqual({ENERGIA:'FIXO'});expect(seen.commits[0].complete).toBe(true);expect(seen.commits[0].mode).toBe('forecast');expect(seen.previews[0].mode).toBe('forecast');expect(seen.commits[0]).not.toHaveProperty('p_rows');expect(seen.commits[0]).not.toHaveProperty('file_sha256');expect(Buffer.from(seen.commits[0].file_base64,'base64').toString('utf8')).toBe(csv);
  expect(seen.commits[0]).toMatchObject({reconciliation_version:'043',full_report:false,resolution_choices:{},previous_financial_revision:'financial-0'});expect(seen.ledger).toEqual([]);expect(seen.writeoffs).toEqual([]);
  await expect(page.getByRole('cell',{name:'cp.csv',exact:true})).toBeVisible();
});
test('linha inválida bloqueia toda importação e informa linha/coluna sem enviar preview',async({page})=>{
  const seen=await setup(page);await analyze(page,csv.replace('16/10/2026','31/02/2026'));
  await expect(page.getByRole('alert')).toContainText('Nenhum pagamento foi registrado por esta análise');await expect(page.getByRole('cell',{name:'Data inexistente.'})).toBeVisible();
  expect(seen.previews).toHaveLength(0);expect(seen.commits).toHaveLength(0);
});
test('XLSX real com data Excel e valor numérico passa análise isolada e mantém centavos exatos',async({page})=>{
  const seen=await setup(page);const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('CP');
  sheet.addRow(['Nº Lançamento','Histórico','Vencimento','Valor','Plano de Contas','Filial']);sheet.addRow(['14','Fornecedor sintético',new Date('2026-10-16T00:00:00Z'),1234.56,'ENERGIA','3']);sheet.getCell('C2').numFmt='dd/mm/yyyy';
  const bytes=await workbook.xlsx.writeBuffer();await page.getByRole('navigation').getByRole('button',{name:'Importar Bases',exact:true}).click();
  await page.getByRole('radio',{name:'Somente novos títulos e atualizações',exact:true}).check();
  await page.getByLabel('Relatório de previsões de Contas a Pagar',{exact:true}).setInputFiles({name:'cp.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(bytes)});
  await page.getByRole('checkbox',{name:'Confirmo o conteúdo do relatório e o tipo de importação selecionado.',exact:true}).check();await page.getByRole('button',{name:'Analisar arquivo',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Conferência antes da importação'})).toBeVisible();await expect(page.getByRole('table',{name:/Prévia dos títulos/}).getByRole('cell',{name:'R$ 1.234,56',exact:true})).toBeVisible();expect(seen.previews).toHaveLength(1);
  expect(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)}))).toEqual({local:[],session:[]});
});
test('base alterada desde preview exige reanálise e não mostra sucesso',async({page})=>{
  await setup(page,{stale:true});await analyze(page);await page.getByLabel('Macro para ENERGIA').selectOption('FIXO');await validateChoices(page);page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Importar e conciliar títulos'}).click();
  await expect(page.getByRole('alert')).toContainText('A base mudou desde a análise');await expect(page.getByRole('heading',{name:'Conferência antes da importação'})).toBeVisible();await expect(page.getByRole('button',{name:'Importar e conciliar títulos'})).toBeDisabled();await expect(page.getByText('private SQL details')).toHaveCount(0);
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
  await page.getByRole('radio',{name:'Somente novos títulos e atualizações',exact:true}).check();
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
  await expect(page.getByRole('button', { name: 'Importar e conciliar títulos' })).toBeDisabled();
  await page.getByLabel('Macro para PLANO ERP SINTÉTICO').selectOption('FIXO');
  await expect(page.getByRole('button', { name: 'Importar e conciliar títulos' })).toBeDisabled();
  await validateChoices(page);
  await expect(page.getByRole('button', { name: 'Importar e conciliar títulos' })).toBeEnabled();
  expect(seen.previews).toHaveLength(2); expect(seen.commits).toHaveLength(0);
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

test('o tipo de relatório não é presumido e precisa ser escolhido explicitamente antes da análise', async ({ page }) => {
  const seen = await setup(page, { knownPlan: true });
  await page.getByRole('navigation').getByRole('button', { name: 'Importar Bases', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Relatório completo de títulos em aberto', exact: true })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'Somente novos títulos e atualizações', exact: true })).not.toBeChecked();
  await page.getByLabel('Relatório de previsões de Contas a Pagar', { exact: true }).setInputFiles({ name: 'cp.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('checkbox', { name: 'Confirmo o conteúdo do relatório e o tipo de importação selecionado.', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Analisar arquivo', exact: true })).toBeDisabled();
  expect(seen.previews).toHaveLength(0);
  await page.getByRole('radio', { name: 'Somente novos títulos e atualizações', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Confirmo o conteúdo do relatório e o tipo de importação selecionado.', exact: true }).check();
  await page.getByRole('button', { name: 'Analisar arquivo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conferência antes da importação', exact: true })).toBeVisible();
  expect(seen.previews[0].full_report).toBe(false);
});

test('relatório completo coleta pagamento efetivo, baixa do ausente e baixa de um centavo antes de uma confirmação atômica', async ({ page }) => {
  const seen = await setup(page, { knownPlan: true, missing: true });
  await analyze(page, csv.replace('1.234,56', '0,01'), true);
  const commit = page.getByRole('button', { name: 'Importar e conciliar títulos', exact: true });
  await expect(commit).toBeDisabled();
  await page.getByRole('combobox', { name: 'Conciliação do lançamento AUSENTE-1 filial 3', exact: true }).selectOption('PAID');
  const date = page.getByLabel('Data do pagamento do lançamento AUSENTE-1 filial 3', { exact: true });
  const amount = page.getByLabel('Valor pago do lançamento AUSENTE-1 filial 3', { exact: true });
  const bank = page.getByRole('combobox', { name: 'Banco pago do lançamento AUSENTE-1 filial 3', exact: true });
  await expect(date).toHaveValue(''); await expect(amount).toHaveValue(''); await expect(bank).toHaveValue('');
  await date.fill('2026-10-17'); await amount.fill('111,11'); await bank.selectOption(account.id);
  await page.getByRole('combobox', { name: 'Conciliação do lançamento AUSENTE-2 filial 3', exact: true }).selectOption('WRITE_OFF');
  await page.getByRole('checkbox', { name: 'Confirmar baixa de R$ 0,01 do lançamento 14 filial 3', exact: true }).check();
  await expect(commit).toBeDisabled();
  expect(seen.commits).toHaveLength(0); expect(seen.ledger).toEqual([]); expect(seen.writeoffs).toEqual([]);
  await validateChoices(page); await expect(commit).toBeEnabled();
  const choices = seen.previews.at(-1).resolution_choices;
  expect(choices[`title:${absentPaid}`]).toMatchObject({ action: 'PAID', paid_on: '2026-10-17', amount_paid_cents: 11111, bank_account_id: account.id });
  expect(choices[`title:${absentWrittenOff}`].action).toBe('WRITE_OFF'); expect(choices['row:1'].action).toBe('WRITE_OFF');
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Pagamentos efetivos informados: 1'); expect(dialog.message()).toContain('Baixas sem pagamento confirmadas individualmente: 2'); return dialog.accept(); });
  await commit.click(); await expect(page.getByRole('status')).toContainText('Importação concluída');
  expect(seen.commits).toHaveLength(1); expect(seen.commits[0].full_report).toBe(true); expect(seen.commits[0].resolution_choices).toEqual(choices);
  expect(seen.ledger).toHaveLength(1); expect(seen.ledger[0]).toMatchObject({ title_id: absentPaid, paid_on: '2026-10-17', amount_paid_cents: 11111, bank_account_id: account.id });
  expect(seen.writeoffs).toEqual(['row:1', `title:${absentWrittenOff}`]);
  expect(seen.remaining.get(absentPaid)).toBe('PAID'); expect(seen.remaining.get(absentWrittenOff)).toBe('WRITE_OFF');
  expect(seen.financialWrites).toEqual([]);
});

test('arquivo incremental preserva ausentes mesmo existindo títulos anteriores na base', async ({ page }) => {
  const seen = await setup(page, { knownPlan: true, missing: true }); await analyze(page);
  await expect(page.getByRole('combobox', { name: /^Conciliação do lançamento AUSENTE/ })).toHaveCount(0);
  const commit = page.getByRole('button', { name: 'Importar e conciliar títulos', exact: true }); await expect(commit).toBeEnabled();
  page.once('dialog', dialog => dialog.accept()); await commit.click(); await expect(page.getByRole('status')).toContainText('Importação concluída');
  expect(seen.commits[0]).toMatchObject({ full_report: false, resolution_choices: {} });
  expect([...seen.remaining.values()]).toEqual(['OPEN', 'OPEN']); expect(seen.ledger).toEqual([]); expect(seen.writeoffs).toEqual([]);
});

test('dois títulos de um centavo exigem duas confirmações individuais e não há baixa em lote presumida', async ({ page }) => {
  const seen = await setup(page, { knownPlan: true });
  const first = csv.replace('1.234,56', '0,01'), second = first.split('\r\n')[1].replace(/^14;/, '15;');
  await analyze(page, `${first}\r\n${second}`);
  const firstCheck = page.getByRole('checkbox', { name: 'Confirmar baixa de R$ 0,01 do lançamento 14 filial 3', exact: true });
  const secondCheck = page.getByRole('checkbox', { name: 'Confirmar baixa de R$ 0,01 do lançamento 15 filial 3', exact: true });
  await firstCheck.check(); await expect(secondCheck).not.toBeChecked(); await validateChoices(page);
  await expect(page.getByRole('button', { name: 'Importar e conciliar títulos', exact: true })).toBeDisabled();
  expect(Object.keys(seen.previews.at(-1).resolution_choices)).toEqual(['row:1']);
  await expect(firstCheck).toBeChecked(); await secondCheck.check(); await validateChoices(page);
  const commit = page.getByRole('button', { name: 'Importar e conciliar títulos', exact: true }); await expect(commit).toBeEnabled();
  expect(seen.writeoffs).toHaveLength(0); expect(seen.ledger).toHaveLength(0);
  page.once('dialog', dialog => dialog.accept()); await commit.click(); await expect(page.getByRole('status')).toContainText('Importação concluída');
  expect(seen.writeoffs).toEqual(['row:1', 'row:2']); expect(seen.ledger).toEqual([]);
});

test('resposta incerta congela bytes, tipo, escolhas e protocolo e repete exatamente a mesma confirmação', async ({ page }) => {
  const seen = await setup(page, { knownPlan: true, uncertain: true }); await analyze(page, csv.replace('1.234,56', '0,01'));
  const cent = page.getByRole('checkbox', { name: 'Confirmar baixa de R$ 0,01 do lançamento 14 filial 3', exact: true }); await cent.check(); await validateChoices(page);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Importar e conciliar títulos', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('A confirmação do resultado não chegou');
  await expect(page.getByLabel('Relatório de previsões de Contas a Pagar', { exact: true })).toBeDisabled();
  await expect(page.getByRole('radio', { name: 'Relatório completo de títulos em aberto', exact: true })).toBeDisabled(); await expect(cent).toBeDisabled();
  await expect(page.getByLabel('Macro para ENERGIA', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Validar escolhas da importação', exact: true })).toBeDisabled();
  const request = seen.commits[0]; expect(request.request_id).toMatch(/^[a-f\d-]{36}$/i); expect(seen.writeoffs).toEqual(['row:1']);
  await page.getByRole('button', { name: 'Repetir confirmação pendente', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Importação concluída' })).toBeVisible();
  expect(seen.commits).toHaveLength(2); expect(seen.commits[1]).toEqual(request); expect(seen.writeoffs).toEqual(['row:1']); expect(seen.ledger).toEqual([]);
  await expect(page.getByLabel('Relatório de previsões de Contas a Pagar', { exact: true })).toBeEnabled();
});

test('serviço antigo sem contrato043 bloqueia a importação sem usar o fluxo anterior', async ({ page }) => {
  const seen = await setup(page, { knownPlan: true, legacyPreview: true }); await analyze(page);
  await expect(page.getByRole('alert')).toContainText('Ative a atualização 043');
  await expect(page.getByRole('heading', { name: 'Conferência antes da importação', exact: true })).toHaveCount(0);
  expect(seen.commits).toHaveLength(0); expect(seen.previews[0].reconciliation_version).toBe('043');
});

test('resposta043 que não aplica a escolha não pode habilitar a confirmação e preserva o preenchimento', async ({ page }) => {
  const seen = await setup(page, { knownPlan: true, ignoreChoices: true }); await analyze(page, csv.replace('1.234,56', '0,01'));
  const cent = page.getByRole('checkbox', { name: 'Confirmar baixa de R$ 0,01 do lançamento 14 filial 3', exact: true }); await cent.check(); await validateChoices(page);
  await expect(page.getByRole('alert')).toContainText('Não foi possível validar esta análise');
  await expect(cent).toBeChecked(); await expect(page.getByRole('button', { name: 'Importar e conciliar títulos', exact: true })).toBeDisabled();
  expect(seen.previews[1].resolution_choices['row:1'].action).toBe('WRITE_OFF'); expect(seen.commits).toHaveLength(0);
});

test('P0043 sem activation_required pede revisar escolhas em vez de reinstalar o banco', async ({ page }) => {
  const seen = await setup(page, { knownPlan: true, rejectChoices: true }); await analyze(page, csv.replace('1.234,56', '0,01'));
  const cent = page.getByRole('checkbox', { name: 'Confirmar baixa de R$ 0,01 do lançamento 14 filial 3', exact: true }); await cent.check(); await validateChoices(page);
  await expect(page.getByRole('alert')).toContainText('Confira as decisões de pagamento e baixa');
  await expect(page.getByRole('alert')).not.toContainText('Ative'); await expect(cent).toBeChecked();
  await expect(page.getByRole('button', { name: 'Importar e conciliar títulos', exact: true })).toBeDisabled(); expect(seen.commits).toHaveLength(0);
  await expect(page.getByText('private SQL details')).toHaveCount(0);
});

test('CSV da baixa administrativa preserva o valor original e informa zero considerado nos totais, status e auditoria', async ({ page }) => {
  await setup(page, { director: true, administrative: true }); await page.getByRole('navigation').getByRole('button', { name: 'Contas a Pagar', exact: true }).click();
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Baixar CSV dos filtros', exact: true }).click();
  const contents = await readFile((await (await pending).path())!, 'utf8');
  const [headers, row] = parseCsv(contents);
  expect(row[headers.indexOf('Valor')]).toBe('1234,56');
  expect(row[headers.indexOf('Valor considerado nos totais')]).toBe('0,00');
  expect(row[headers.indexOf('Baixa sem pagamento')]).toBe('BAIXADO SEM PAGAMENTO');
  expect(row[headers.indexOf('Motivo da baixa sem pagamento')]).toBe('Baixa administrativa sintética confirmada');
  expect(row[headers.indexOf('Responsável pela baixa sem pagamento')]).toBe('10000000-0000-4000-8000-000000000001');
});
