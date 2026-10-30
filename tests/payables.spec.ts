import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const project='https://sjimddcqgrsauzvffcol.supabase.co';
interface Options { director?: boolean; precision?: boolean; cheque?: boolean; administrative?: boolean }
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
  const seen={queries:[] as string[],financialWrites:[] as string[]};
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
    if(url.pathname==='/rest/v1/rpc/payables_summary')return reply({open_cents:123456,overdue_cents:0,period_cents:123456,active_count:1,latest_import_at:null});
    if(url.pathname==='/rest/v1/rpc/receivables_summary')return reply({open_cents:0,overdue_cents:0,period_cents:0,active_count:0,pending_count:0,unassigned_count:0,received_period_cents:0,latest_import_at:null,overdue_bps:null,overdue_comlurb_cents:null});
    if(url.pathname==='/rest/v1/director_positions')return reply([],200,0);
    if(url.pathname==='/rest/v1/payable_macros')return reply([{name:'FIXO'},{name:'VARIÁVEL'}],200,2);
    if(url.pathname==='/rest/v1/payable_plan_mappings')return reply([],200,0);
    if(url.pathname==='/rest/v1/payable_imports')return reply([],200,0);
    if(url.pathname==='/rest/v1/payable_titles'){seen.queries.push(url.search);return reply(url.searchParams.get('status')==='eq.SETTLED_IMPORT'?[]:[title],200,url.searchParams.get('status')==='eq.SETTLED_IMPORT'?0:1);}
    if(req.method()!=='GET')seen.financialWrites.push(url.pathname);
    throw new Error(`Unexpected offline request ${req.method()} ${url.pathname}`);
  });
  await page.goto('/');await page.getByLabel('Usuário',{exact:true}).fill('UsuarioTeste');await page.getByLabel('Senha',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'Entrar na Central'}).click();await expect(page.getByRole('button',{name:'Sair',exact:false})).toBeVisible();
  return seen;
}
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
