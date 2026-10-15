import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthGateway } from './handler.mjs';

const ORIGIN='https://central.example.test', USER='11111111-1111-4111-8111-111111111111', SESSION='22222222-2222-4222-8222-222222222222', TICKET='33333333-3333-4333-8333-333333333333';
const token=`header.${Buffer.from(JSON.stringify({sub:USER,session_id:SESSION})).toString('base64url')}.signature`;
const ENV={ALLOWED_ORIGINS:ORIGIN,SUPABASE_URL:'https://project.example.test',SUPABASE_ANON_KEY:'public-test',SUPABASE_SERVICE_ROLE_KEY:'secret-test'};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const request=(body,headers={})=>new Request('https://project.example.test/functions/v1/auth-gateway',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
function harness(overrides={}) {
  const calls=[],logs=[];
  const handler=createAuthGateway({env:key=>ENV[key],log:message=>logs.push(message),fetch:async(url,init)=>{
    const parsed=new URL(url), path=parsed.pathname, key=`${init.method} ${path}`;
    const data=init.body?JSON.parse(init.body):null;
    calls.push({url,path,init,data});
    const override=overrides[key]??overrides[path];
    if(override) return typeof override==='function'?override(data,init):override;
    if(path.endsWith('/resolve_login'))return json({allowed:true,ticket:TICKET,user_id:USER,email:'private-email@example.test'});
    if(path.endsWith('/finish_password_recovery')||path.endsWith('/finish_password_change'))return json(true);
    if(path.endsWith('/begin_password_change'))return json({allowed:true,ticket:TICKET});
    if(path==='/auth/v1/recover')return json({});
    if(path==='/auth/v1/user')return json({id:USER});
    if(path==='/auth/v1/logout')return new Response(null,{status:204});
    throw Error('Unexpected test path');
  }});
  return{handler,calls,logs};
}
const reset={action:'request_password_reset',username:'ExampleUser'};
const change={action:'change_password',password:'new-long-password'};
const bearer={Authorization:`Bearer ${token}`};

test('recovery dispatch is server-only, exact-origin redirected, audited without login or client email',async()=>{
  const h=harness(),result=await h.handler(request(reset));
  assert.equal(result.status,202);
  const text=await result.text();assert(!text.includes('private-email'));assert(!text.includes('secret-test'));
  const recovery=h.calls.find(c=>c.path==='/auth/v1/recover');
  assert.equal(new URL(recovery.url).searchParams.get('redirect_to'),`${ORIGIN}/?password-reset=1`);
  assert.deepEqual(recovery.data,{email:'private-email@example.test'});
  assert.equal(recovery.init.headers.apikey,'public-test');
  assert(h.calls.every(c=>!c.path.endsWith('/finish_login')));
  assert.deepEqual(h.calls.at(-1).data,{p_ticket:TICKET,p_accepted:true,p_user_agent:''});
});

test('unknown/inactive user, provider rejection and provider exception return identical generic recovery response',async()=>{
  const variants=[{}, {'/rest/v1/rpc/resolve_login':json({allowed:true,ticket:TICKET,email:null,user_id:null})}, {'/auth/v1/recover':json({error:'sensitive-provider-email'},429)}, {'/auth/v1/recover':()=>{throw Error('private-email@example.test secret-test');}}];
  const bodies=[];
  for(const overrides of variants){const h=harness(overrides),r=await h.handler(request(reset));assert.equal(r.status,202);bodies.push(await r.text());assert(!JSON.stringify(h.logs).includes('private-email'));assert(!JSON.stringify(h.logs).includes('secret-test'));}
  assert(bodies.every(b=>b===bodies[0]));
});

test('recovery invalid origins, spoofed identity, rate limits and audit outage fail closed',async()=>{
  const bad=harness();assert.equal((await bad.handler(request(reset,{Origin:'https://evil.test'}))).status,403);assert.equal(bad.calls.length,0);
  const injected=harness();assert.equal((await injected.handler(request({...reset,email:'injected@example.test'}))).status,400);assert.equal(injected.calls.length,0);
  const rate=harness({'/rest/v1/rpc/resolve_login':json({allowed:false,retry_after:80})});const r=await rate.handler(request(reset));assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'80');assert.equal(rate.calls.length,1);
  const audit=harness({'/rest/v1/rpc/finish_password_recovery':json({error:'private-db'},500)});const failed=await audit.handler(request(reset));assert.equal(failed.status,503);assert(!(await failed.text()).includes('private-db'));
});

test('verified recovery JWT changes only its own active profile password without approving application access',async()=>{
  const h=harness(),r=await h.handler(request(change,bearer));assert.equal(r.status,200);assert.deepEqual(await r.json(),{password_changed:true,signed_out:true});
  assert.deepEqual(h.calls.map(c=>`${c.init.method} ${c.path}`),['GET /auth/v1/user','POST /rest/v1/rpc/begin_password_change','PUT /auth/v1/user','POST /rest/v1/rpc/finish_password_change','POST /auth/v1/logout']);
  assert.deepEqual(h.calls[1].data,{p_user_id:USER,p_session_id:SESSION,p_user_agent:''});
  assert.deepEqual(h.calls[2].data,{password:change.password});assert.deepEqual(h.calls[3].data,{p_ticket:TICKET,p_success:true});
  assert(h.calls.every(c=>!c.path.includes('current_access')&&!c.path.includes('finish_login')));assert.deepEqual(h.logs,[]);
});

test('password changes reject missing/expired JWT, inactive profile, rate and browser identities before Auth writes',async()=>{
  const no=harness();assert.equal((await no.handler(request(change))).status,401);assert.equal(no.calls.length,0);
  const expired=harness({'GET /auth/v1/user':json({error:'expired'},401)});assert.equal((await expired.handler(request(change,bearer))).status,401);assert.equal(expired.calls.length,1);
  for(const admission of [{allowed:false,reason:'inactive'},{allowed:false,retry_after:10}]){const h=harness({'/rest/v1/rpc/begin_password_change':json(admission)});assert.equal((await h.handler(request(change,bearer))).status,admission.reason?401:429);assert.equal(h.calls.length,2);}
  for(const body of [{...change,userId:USER},{...change,role:'admin'},{...change,password:'short'},{...change,password:'x'.repeat(1025)}]){const h=harness();assert.equal((await h.handler(request(body,bearer))).status,400);assert.equal(h.calls.length,0);}
});

test('password change audit failure before Auth prevents mutation; after Auth returns explicit uncertainty and revokes token',async()=>{
  const before=harness({'/rest/v1/rpc/begin_password_change':json({error:'audit-secret'},500)});assert.equal((await before.handler(request(change,bearer))).status,503);assert.equal(before.calls.length,2);
  const after=harness({'/rest/v1/rpc/finish_password_change':json({error:'audit-secret'},500)});const r=await after.handler(request(change,bearer));assert.equal(r.status,503);const body=await r.json();assert.match(body.error,/pode ter sido alterada/);assert(!JSON.stringify(body).includes('audit-secret'));assert.equal(after.calls.at(-1).path,'/auth/v1/logout');assert.deepEqual(after.logs,['password_change_completion_unavailable']);
});

test('Auth password rejection is audited without upstream details or password leaking',async()=>{
  const h=harness({'PUT /auth/v1/user':json({error:'private-policy secret-test'},422)}),r=await h.handler(request(change,bearer));assert.equal(r.status,400);const text=await r.text();assert(!text.includes('private-policy'));assert(!text.includes(change.password));assert.equal(h.calls.at(-1).data.p_success,false);assert.deepEqual(h.logs,[]);
});

test('lost or indeterminate Auth update response produces uncertainty audit, revocation and explicit uncertainty message',async()=>{
 for(const reply of [()=>{throw Error('lost-response private-secret');},json({error:'private-server-error'},500),json({error:'private-timeout'},408)]){
  const h=harness({'PUT /auth/v1/user':reply}),r=await h.handler(request(change,bearer));assert.equal(r.status,503);assert.match((await r.json()).error,/pode ter sido alterada/);assert.equal(h.calls.find(c=>c.path.endsWith('/finish_password_change')).data.p_success,null);assert.equal(h.calls.at(-1).path,'/auth/v1/logout');assert.deepEqual(h.logs,['password_change_completion_unavailable']);
 }
});
