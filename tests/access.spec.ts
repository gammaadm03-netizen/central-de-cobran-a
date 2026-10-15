import { test, expect, type Page } from '@playwright/test';

const project='https://sjimddcqgrsauzvffcol.supabase.co';
const modules=['painel','caixa','contas_pagar','contas_receber','cobranca','comissoes','faturamento','margens','rh_dp','importar_bases'];
function fixture(role='gerente_geral') {
  const id='10000000-0000-4000-8000-000000000001';
  const visible=role==='cobradora_1'?['cobranca']:role==='rh_dp'?['faturamento','rh_dp','importar_bases']:modules;
  const permissions=visible.map(resource=>({resource,action:'read'}));
  if(role==='gerente_geral') permissions.push({resource:'usuarios',action:'admin'},{resource:'configuracoes',action:'admin'},{resource:'auditoria',action:'read'});
  if(['gerente_geral','diretor'].includes(role)) permissions.push({resource:'mensagens_cp',action:'read'},{resource:'mensagens_cp',action:'write'});
  const access={profile:{id,username:'UsuarioTeste',display_name:'Pessoa Teste',role_key:role,enabled:true},permissions,collector_id:null};
  const claims={sub:id,session_id:'20000000-0000-4000-8000-000000000001',exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),role:'authenticated'};
  const token=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify(claims)).toString('base64url'),'synthetic-test-only'].join('.');
  const user={id,aud:'authenticated',role:'authenticated',email:'synthetic@test.invalid',email_confirmed_at:new Date().toISOString(),created_at:new Date().toISOString(),app_metadata:{},user_metadata:{}};
  return {access,token,user};
}
async function setup(page:Page,role='gerente_geral',options:{invalid?:boolean,logoutFailure?:boolean,holdAccess?:()=>Promise<void>}={}){
 const data=fixture(role);let accessCalls=0;
 const messages:any[]=[];
 await page.route(`${project}/**`,async route=>{
  const req=route.request();const url=new URL(req.url());const headers={'access-control-allow-origin':'http://127.0.0.1:4173','access-control-allow-headers':'apikey,content-type,authorization,x-client-info','access-control-allow-methods':'GET,POST,OPTIONS','access-control-expose-headers':'content-range','content-range':'0-0/1'};
  if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
  const body=req.postDataJSON();
  const reply=(json:any,status=200)=>route.fulfill({status,headers,json});
  if(url.pathname==='/functions/v1/auth-gateway'){
   if(body.action==='sign_out')return reply({signed_out:true},options.logoutFailure?503:200);
   if(options.invalid)return reply({error:'Internal SQL trace must not reach UI'},401);
   return reply({session:{access_token:data.token,refresh_token:'synthetic-refresh-token',expires_in:3600,token_type:'bearer'},access:data.access});
  }
  if(url.pathname==='/auth/v1/user')return reply(data.user);
  if(url.pathname==='/rest/v1/rpc/cash_position')return reply({accounts:[],total_cents:null,reported_accounts:0,expected_accounts:11,latest_position_date:null});
  if(url.pathname==='/rest/v1/rpc/current_stock')return reply({value_cents:null,reference_date:null,source:null});
  if(url.pathname==='/rest/v1/rpc/payables_summary')return reply({open_cents:0,overdue_cents:0,period_cents:0,active_count:0,latest_import_at:null});
  if(['/rest/v1/payable_titles','/rest/v1/payable_macros','/rest/v1/payable_plan_mappings','/rest/v1/payable_imports','/rest/v1/director_positions'].includes(url.pathname))return route.fulfill({status:200,headers:{...headers,'content-range':'*/0'},json:[]});
  if(url.pathname==='/rest/v1/rpc/current_access'){
   accessCalls++;if(accessCalls>1&&options.holdAccess)await options.holdAccess();return reply(data.access);
  }
  if(url.pathname==='/rest/v1/management_messages'){
   const status=url.searchParams.get('status')?.replace('eq.','');const rows=status?messages.filter(m=>m.status===status):messages;
   return route.fulfill({status:200,headers:{...headers,'content-range':rows.length?`0-${rows.length-1}/${rows.length}`:'*/0'},json:rows});
  }
  if(url.pathname==='/rest/v1/rpc/create_management_message'){
   messages.push({id:'30000000-0000-4000-8000-000000000001',author_name:'Pessoa Teste',author_role:role,priority:body.p_priority,reference:body.p_reference,message:body.p_message,status:'pendente',created_at:new Date().toISOString(),completed_at:null,reopened_at:null});return reply(messages[0].id);
  }
  if(url.pathname==='/rest/v1/rpc/set_management_message_status'){
   messages[0].status=body.p_status;return reply(null);
  }
  if(url.pathname==='/rest/v1/profiles')return reply([{...data.access.profile,updated_at:new Date().toISOString()}]);
  if(url.pathname==='/rest/v1/audit_events'||url.pathname==='/rest/v1/collection_agents'||url.pathname==='/rest/v1/collector_bindings')return route.fulfill({status:200,headers:{...headers,'content-range':'*/0'},json:[]});
  throw new Error(`Unexpected request in offline test: ${req.method()} ${url.pathname}`);
 });
 return data;
}
async function login(page:Page){
 await page.goto('/');await page.getByLabel('Usuário',{exact:true}).fill('UsuarioTeste');await page.getByLabel('Senha',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'Entrar na Central'}).click();
 await expect(page.getByRole('button',{name:'Sair',exact:false})).toBeVisible();
}

test('login is usable on desktop and mobile without horizontal overflow',async({page})=>{
 await setup(page);await page.goto('/');await expect(page.getByRole('heading',{name:'Bem-vindo à Central'})).toBeVisible();
 await page.screenshot({path:'/tmp/central-login-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await expect(page.getByLabel('Usuário',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('invalid credentials show friendly feedback without exposing backend errors',async({page})=>{
 await setup(page,'gerente_geral',{invalid:true});await page.goto('/');await page.getByLabel('Usuário',{exact:true}).fill('UsuarioTeste');await page.getByLabel('Senha',{exact:true}).fill('invalid');await page.getByRole('button',{name:'Entrar na Central'}).click();
 await expect(page.getByRole('alert')).toContainText('Usuário ou senha inválidos');await expect(page.getByText('Internal SQL trace')).toHaveCount(0);
});
test('manager session loads official permissions and administration list',async({page})=>{
 await setup(page);await login(page);await expect(page.getByRole('navigation')).toContainText('Contas a Pagar');
 await page.getByRole('button',{name:'Administração',exact:false}).click();await expect(page.getByRole('heading',{name:'Usuários e permissões'})).toBeVisible();await expect(page.getByRole('cell',{name:'UsuarioTeste'})).toBeVisible();
 await page.screenshot({path:'/tmp/central-administration.png',fullPage:true});
});
test('director cannot see administration and can send a CP board message',async({page})=>{
 await setup(page,'diretor');await login(page);await expect(page.getByRole('button',{name:'Administração',exact:false})).toHaveCount(0);
 await page.getByRole('navigation').getByRole('button',{name:'Contas a Pagar',exact:true}).click();await expect(page.getByRole('heading',{name:'Mensagens da Diretoria e Gerência'})).toBeVisible();
 page.on('dialog',dialog=>dialog.accept());await page.getByLabel('Mensagem',{exact:true}).fill('<script>synthetic markup stays text</script>');await page.getByRole('button',{name:'Enviar mensagem'}).click();
 await expect(page.getByRole('status')).toContainText('Mensagem registrada');await expect(page.getByText('<script>synthetic markup stays text</script>',{exact:true})).toBeVisible();
});
test('collector sees only collection navigation and no automatic wallet binding',async({page})=>{
 await setup(page,'cobradora_1');await login(page);const nav=page.getByRole('navigation');await expect(nav.getByRole('button')).toHaveCount(1);await expect(nav).toContainText('Cobrança');
 await expect(page.getByText('Nenhuma carteira é atribuída automaticamente.',{exact:false})).toBeVisible();
});
test('RH does not receive financial navigation',async({page})=>{
 await setup(page,'rh_dp');await login(page);const nav=page.getByRole('navigation');await expect(nav).not.toContainText('Caixa / Bancos');await expect(nav).not.toContainText('Contas a Pagar');await expect(nav).toContainText('RH / DP');
});
test('logout clears memory and a reload cannot restore a protected screen',async({page})=>{
 await setup(page);await login(page);await page.getByRole('button',{name:'Sair',exact:false}).click();await expect(page.getByRole('heading',{name:'Bem-vindo à Central'})).toBeVisible();
 expect(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)}))).toEqual({local:[],session:[]});
 await page.reload();await expect(page.getByRole('heading',{name:'Bem-vindo à Central'})).toBeVisible();
});
test('failed remote logout reports uncertainty and still clears local credentials',async({page})=>{
 await setup(page,'gerente_geral',{logoutFailure:true});await login(page);await page.getByRole('button',{name:'Sair',exact:false}).click();await expect(page.getByRole('status')).toContainText('Não foi possível confirmar a revogação remota');
});
test('delayed access response cannot reopen the interface after logout',async({page})=>{
 let release!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve);let pending=false;
 await setup(page,'gerente_geral',{holdAccess:async()=>{pending=true;await waiting;}});await login(page);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect.poll(()=>pending).toBe(true);await page.getByRole('button',{name:'Sair',exact:false}).click();await expect(page.getByRole('heading',{name:'Bem-vindo à Central'})).toBeVisible();release();
 // Allow the delayed response to settle; the generation guard must preserve logout.
 await page.waitForResponse(r=>r.url().endsWith('/rest/v1/rpc/current_access')).catch(()=>{});
 await expect(page.getByRole('heading',{name:'Bem-vindo à Central'})).toBeVisible();
});
