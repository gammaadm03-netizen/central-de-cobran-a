import { test,expect,type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { parseCsv,validateReceivableRows } from '../src/lib/receivables-parser.mjs';
const project='https://sjimddcqgrsauzvffcol.supabase.co';
const csv='NF;Órgão;Filial;Vencimento;Valor;Emissão;CNPJ\r\n00014;Cliente sintético;3;16/10/2026;1.234,56;01/10/2026;12.345.678/0001-90';
async function setup(page:Page,options:{ stale?:boolean; serverInvalid?:boolean; validatedPresent?:boolean }={}) {
  const id='10000000-0000-4000-8000-000000000001';
  const access={profile:{id,username:'UsuarioTeste',display_name:'Pessoa Teste',role_key:'contas_receber',enabled:true},permissions:[{resource:'painel',action:'read'},{resource:'contas_receber',action:'read'},{resource:'contas_receber',action:'import'},{resource:'importar_bases',action:'read'}],collector_id:null};
  const claims={sub:id,session_id:'20000000-0000-4000-8000-000000000001',exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),role:'authenticated'};
  const token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify(claims)).toString('base64url'),'synthetic-test-only'].join('.');
  const user={id,aud:'authenticated',role:'authenticated',email:'synthetic@test.invalid',created_at:new Date().toISOString(),app_metadata:{},user_metadata:{}};
  const seen:{ previews:any[];commits:any[];financialWrites:string[] }={previews:[],commits:[],financialWrites:[]};let imported=false;
  await page.route(`${project}/**`,async route => {
    const req=route.request(),url=new URL(req.url()),body=req.postDataJSON();
    const headers={'access-control-allow-origin':'http://127.0.0.1:4173','access-control-allow-headers':'apikey,content-type,authorization,x-client-info,prefer','access-control-allow-methods':'GET,POST,OPTIONS','access-control-expose-headers':'content-range'};
    const reply=(json:any,status=200)=>route.fulfill({status,headers:{...headers,'content-range':'*/0'},json});
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
    if(url.pathname==='/functions/v1/auth-gateway')return reply({session:{access_token:token,refresh_token:'synthetic-refresh',expires_in:3600,token_type:'bearer'},access});
    if(url.pathname==='/auth/v1/user')return reply(user);
    if(url.pathname==='/rest/v1/rpc/current_access')return reply(access);
    if(url.pathname==='/rest/v1/rpc/cash_position')return reply({accounts:[],total_cents:null,reported_accounts:0,expected_accounts:11,latest_position_date:null});
    if(url.pathname==='/rest/v1/rpc/current_stock')return reply({value_cents:null,reference_date:null,source:null});
    if(url.pathname==='/rest/v1/rpc/payables_summary')return reply({open_cents:0,overdue_cents:0,period_cents:0,active_count:0,latest_import_at:null});
    if(url.pathname==='/rest/v1/rpc/receivables_summary')return reply({open_cents:0,overdue_cents:0,period_cents:0,active_count:0,latest_import_at:null});
    if(url.pathname==='/rest/v1/director_positions')return reply([]);
    if(url.pathname==='/rest/v1/receivable_imports')return reply(imported?[{id:'40000000-0000-4000-8000-000000000001',created_at:'2026-10-16T12:00:00Z',file_name:'cr.csv',row_count:1,new_count:1,open_count:0,pending_count:2,validated_in_source_count:0}]:[]);
    if(url.pathname==='/functions/v1/receivables-import') {
      if(body.action==='preview') {
        seen.previews.push(body);
        if(options.serverInvalid)return reply({code:'22023',errors:[{line:2,column:'CNPJ',problem:'CNPJ deve conter exatamente 14 dígitos. Não complete zeros automaticamente.',correction:'Corrija a célula no arquivo original e selecione uma nova cópia.'}],error:'private stack trace'},422);
        const bytes=Buffer.from(body.file_base64,'base64');let matrix:unknown[][];
        if(body.file_name.endsWith('.csv'))matrix=parseCsv(bytes.toString('utf8'));
        else { const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);matrix=[];workbook.worksheets[0].eachRow(row=>matrix.push((row.values as unknown[]).slice(1))); }
        const parsed=validateReceivableRows(matrix);
        return reply({rows:parsed.rows,file_sha256:createHash('sha256').update(bytes).digest('hex'),preview:{previous_import_id:null,row_count:1,new_count:options.validatedPresent?0:1,open_count:0,pending_count:2,validated_in_source_count:options.validatedPresent?1:0}});
      }
      seen.commits.push(body);
      if(options.stale)return reply({code:'40001',error:'private SQL details'},409);
      imported=true;return reply({import_id:'40000000-0000-4000-8000-000000000001',row_count:1,new_count:1,open_count:0,pending_count:2,validated_in_source_count:0});
    }
    if(req.method()!=='GET') {seen.financialWrites.push(url.pathname);throw new Error(`Unexpected financial write ${url.pathname}`);}
    throw new Error(`Unexpected offline read ${url.pathname}`);
  });
  await page.goto('/');await page.getByLabel('Usuário',{exact:true}).fill('UsuarioTeste');await page.getByLabel('Senha',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'Entrar na Central'}).click();await expect(page.getByRole('button',{name:'Sair',exact:false})).toBeVisible();
  await page.getByRole('navigation').getByRole('button',{name:'Importar Bases',exact:true}).click();await page.getByRole('tab',{name:'Contas a Receber',exact:true}).click();
  return seen;
}
async function analyze(page:Page,content=csv) {
  await page.getByLabel('Relatório completo de Contas a Receber',{exact:true}).setInputFiles({name:'cr.csv',mimeType:'text/csv',buffer:Buffer.from(content)});
  await page.getByRole('checkbox',{name:'Confirmo que este é o relatório COMPLETO de Contas a Receber da mesma origem Grupo consolidado.'}).check();
  await page.getByRole('button',{name:'Analisar arquivo',exact:true}).click();
}
test('CR exige relatório completo e confirmação sem baixar financeiramente as ausências',async({page})=>{
  const seen=await setup(page);
  await page.getByLabel('Relatório completo de Contas a Receber',{exact:true}).setInputFiles({name:'cr.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
  await expect(page.getByRole('button',{name:'Analisar arquivo',exact:true})).toBeDisabled();
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Analisar arquivo',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Conferência de Contas a Receber'})).toBeVisible();await expect(page.getByText('2 novas ausências aguardando validação.',{exact:true})).toBeVisible();
  page.once('dialog',dialog=>{expect(dialog.message()).toContain('AGUARDANDO VALIDAÇÃO');expect(dialog.message()).toContain('As carteiras e o histórico serão preservados');return dialog.accept();});
  await page.getByRole('button',{name:'Concluir importação completa de CR'}).click();
  await expect(page.getByRole('status')).toContainText('Nenhum recebimento foi confirmado');
  expect(seen.commits).toHaveLength(1);expect(seen.commits[0]).toEqual({action:'commit',file_name:'cr.csv',file_base64:Buffer.from(csv).toString('base64'),complete:true,previous_import_id:null});
  expect(seen.financialWrites).toEqual([]);await expect(page.getByRole('cell',{name:'cr.csv',exact:true})).toBeVisible();
});
test('CR bloqueia coluna ausente e data inválida sem sequer enviar a análise ao servidor',async({page})=>{
  const seen=await setup(page);await analyze(page,csv.replace('16/10/2026','31/02/2026'));
  await expect(page.getByRole('alert')).toContainText('Nenhum dado foi alterado');await expect(page.getByRole('cell',{name:'Data inexistente.'})).toBeVisible();
  await analyze(page,'NF;Cliente;Filial;Valor\r\n14;Cliente;3;1,00');
  await expect(page.getByRole('cell',{name:'Coluna obrigatória ausente.'})).toBeVisible();
  expect(seen.previews).toHaveLength(0);expect(seen.commits).toHaveLength(0);
});
test('CR aceita XLSX real, conserva centavos e não usa armazenamento local',async({page})=>{
  const seen=await setup(page),workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('CR');
  sheet.addRow(['Documento','Cliente','Filial','Vencimento','Valor']);sheet.addRow(['00014','Cliente sintético','3',new Date('2026-10-16T00:00:00Z'),1234.56]);sheet.getCell('D2').numFmt='dd/mm/yyyy';
  const bytes=await workbook.xlsx.writeBuffer();await page.getByLabel('Relatório completo de Contas a Receber',{exact:true}).setInputFiles({name:'cr.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(bytes)});
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Analisar arquivo',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Conferência de Contas a Receber'})).toBeVisible();await expect(page.getByText('total R$ 1.234,56',{exact:false})).toBeVisible();expect(seen.previews).toHaveLength(1);
  expect(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)}))).toEqual({local:[],session:[]});
});
test('CR com base alterada exige nova análise e oculta erros técnicos',async({page})=>{
  await setup(page,{stale:true});await analyze(page);await expect(page.getByRole('heading',{name:'Conferência de Contas a Receber'})).toBeVisible();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Concluir importação completa de CR'}).click();
  await expect(page.getByRole('alert')).toContainText('A base mudou desde a análise');await expect(page.getByRole('heading',{name:'Conferência de Contas a Receber'})).toHaveCount(0);await expect(page.getByText('private SQL details')).toHaveCount(0);
});
test('CR mostra erros estruturados do servidor sem stack trace e sem permitir conclusão',async({page})=>{
  const seen=await setup(page,{serverInvalid:true});await analyze(page);
  await expect(page.getByRole('cell',{name:'CNPJ deve conter exatamente 14 dígitos. Não complete zeros automaticamente.'})).toBeVisible();await expect(page.getByText('private stack trace')).toHaveCount(0);await expect(page.getByRole('button',{name:'Concluir importação completa de CR'})).toHaveCount(0);expect(seen.commits).toHaveLength(0);
});

test('CR avisa sobre título validado na origem e mantém conclusão sem prometer reabertura',async({page})=>{
  const seen=await setup(page,{validatedPresent:true});await analyze(page);
  await expect(page.getByRole('heading',{name:'Conferência de Contas a Receber'})).toBeVisible();
  await expect(page.getByText('1 título(s) já validado(s) reaparecem no relatório. Permanecerão validados; confira a origem do arquivo.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Concluir importação completa de CR'})).toBeEnabled();expect(seen.commits).toHaveLength(0);expect(seen.financialWrites).toEqual([]);
});
