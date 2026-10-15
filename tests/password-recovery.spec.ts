import {test,expect,type Page} from '@playwright/test';
const project='https://sjimddcqgrsauzvffcol.supabase.co';
const user={id:'90000000-0000-4000-8000-000000000001',email:'synthetic@test.invalid',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()};
const jwt=[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,session_id:'91000000-0000-4000-8000-000000000001',exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'})).toString('base64url'),'synthetic-recovery-signature'].join('.');
const link=`/?password-reset=1#access_token=${jwt}&refresh_token=synthetic-recovery-refresh&type=recovery`;
async function setup(page:Page,options:{invalid?:boolean,changeStatus?:number,userStatus?:number,networkFailure?:boolean}={}){
 const calls:{action:string;authorization:string|null;password?:string}[]=[];
 await page.route(`${project}/**`,async route=>{
  const req=route.request(),url=new URL(req.url());
  const headers={'access-control-allow-origin':'http://127.0.0.1:4173','access-control-allow-headers':'apikey,content-type,authorization,x-client-info','access-control-allow-methods':'GET,POST,OPTIONS'};
  const reply=(json:any,status=200)=>route.fulfill({status,headers,json});
  if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
  if(url.pathname==='/auth/v1/user'){
   if(options.networkFailure)return route.abort('failed');
   if(options.userStatus)return reply({message:'private upstream detail'},options.userStatus);
   return options.invalid?reply({message:'invalid token'},401):reply(user);
  }
  if(url.pathname==='/auth/v1/logout')return route.fulfill({status:204,headers});
  if(url.pathname==='/functions/v1/auth-gateway'){
   const b=req.postDataJSON();calls.push({action:b.action,authorization:req.headers().authorization??null,password:b.password});
   if(b.action==='request_password_reset')return reply({message:'Se o acesso estiver ativo, enviaremos as instruções de redefinição ao e-mail cadastrado.'},202);
   if(b.action==='change_password')return reply({password_changed:true,signed_out:true},options.changeStatus??200);
  }
  // A recovery session must never request current_access, financial tables, or login approval.
  throw new Error(`Unexpected request in isolated recovery flow: ${req.method()} ${url.pathname}`);
 });
 return calls;
}

test('forgot-password submits only username and displays generic response',async({page})=>{
 const calls=await setup(page);await page.goto('/');await page.getByRole('button',{name:'Esqueci minha senha',exact:true}).click();
 await page.getByLabel('Usuário',{exact:true}).fill('UsuarioTeste');await page.getByRole('button',{name:'Enviar instruções'}).click();
 await expect(page.getByRole('status')).toContainText('Se o acesso estiver ativo');expect(calls).toHaveLength(1);expect(calls[0].action).toBe('request_password_reset');expect(calls[0].password).toBeUndefined();
});
test('valid recovery link is removed from URL and cannot open the administration',async({page})=>{
 await setup(page);await page.goto(link);await expect(page.getByLabel('Nova senha',{exact:true})).toBeVisible();
 expect(page.url()).not.toContain('access_token');expect(page.url()).not.toContain('refresh_token');expect(page.url()).not.toContain('password-reset');
 await expect(page.getByRole('navigation')).toHaveCount(0);expect(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)}))).toEqual({local:[],session:[]});
});
test('new password needs matching confirmation and successful save returns to login',async({page})=>{
 const calls=await setup(page);await page.goto(link);await expect(page.getByLabel('Nova senha',{exact:true})).toBeVisible();
 await page.getByLabel('Nova senha',{exact:true}).fill('Synthetic-Password-2026');await page.getByLabel('Confirmar nova senha',{exact:true}).fill('Different-Password-2026');await page.getByRole('button',{name:'Salvar nova senha'}).click();await expect(page.getByRole('alert')).toContainText('precisam ser iguais');expect(calls).toHaveLength(0);
 await page.getByLabel('Confirmar nova senha',{exact:true}).fill('Synthetic-Password-2026');page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Salvar nova senha'}).click();
 await expect(page.getByRole('heading',{name:'Bem-vindo à Central'})).toBeVisible();await expect(page.getByRole('status')).toContainText('Sua senha foi alterada');expect(calls[0].action).toBe('change_password');expect(calls[0].authorization).toBe(`Bearer ${jwt}`);
});
test('invalid or expired link never shows password form',async({page})=>{
 await setup(page,{invalid:true});await page.goto(link);await expect(page.getByRole('alert')).toContainText('inválido ou expirou');await expect(page.getByLabel('Nova senha',{exact:true})).toHaveCount(0);
});
test('missing recovery credentials cannot become a normal logged-in session',async({page})=>{
 await setup(page);await page.goto('/?password-reset=1');await expect(page.getByRole('alert')).toContainText('sem os dados necessários');await expect(page.getByText('Referência: REC-01',{exact:true})).toBeVisible();await expect(page.getByRole('navigation')).toHaveCount(0);
});

test('explicit expired recovery callback is classified without exposing provider text or requesting a session',async({page})=>{
 const calls=await setup(page),requests:string[]=[];page.on('request',request=>{if(request.url().startsWith(project))requests.push(request.url());});
 await page.goto('/?password-reset=1#error=access_denied&error_code=otp_expired&error_description=private-callback-text');
 await expect(page.getByRole('alert')).toContainText('inválido ou expirou');await expect(page.getByText('Referência: REC-02',{exact:true})).toBeVisible();
 expect(page.url()).not.toContain('error');await expect(page.locator('body')).not.toContainText('private-callback-text');expect(requests).toEqual([]);expect(calls).toEqual([]);
});

test('unrecognized callback errors are sanitized and denied without displaying raw error details',async({page})=>{
 await setup(page);await page.goto('/?password-reset=1&error=private-error&error_code=unknown_provider&error_description=private-provider-text');
 await expect(page.getByText('Referência: REC-03',{exact:true})).toBeVisible();await expect(page.getByLabel('Nova senha',{exact:true})).toHaveCount(0);
 expect(page.url()).not.toContain('error');await expect(page.locator('body')).not.toContainText('private-provider-text');
});

for(const failure of [403,503,'network'] as const){
 test(`Auth verification ${failure} is reported as unavailable, never as an expired email link`,async({page})=>{
  const calls=await setup(page,failure==='network'?{networkFailure:true}:{userStatus:failure});await page.goto(link);
  await expect(page.getByRole('alert')).toContainText('Não foi possível conectar ao serviço de autenticação');await expect(page.getByText('Referência: REC-05',{exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText('expirou');await expect(page.getByLabel('Nova senha',{exact:true})).toHaveCount(0);await expect(page.getByRole('navigation')).toHaveCount(0);
  expect(page.url()).not.toContain('access_token');await expect(page.locator('body')).not.toContainText('private upstream detail');expect(calls).toEqual([]);
 });
}
test('uncertain completion never claims success and directs to another recovery link',async({page})=>{
 await setup(page,{changeStatus:503});await page.goto(link);await expect(page.getByLabel('Nova senha',{exact:true})).toBeVisible();
 await page.getByLabel('Nova senha',{exact:true}).fill('Synthetic-Password-2026');await page.getByLabel('Confirmar nova senha',{exact:true}).fill('Synthetic-Password-2026');page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Salvar nova senha'}).click();
 await expect(page.getByRole('alert')).toContainText('pode ter sido alterada');await expect(page.getByRole('status')).toHaveCount(0);await expect(page.getByLabel('Nova senha',{exact:true})).toHaveCount(0);
});
