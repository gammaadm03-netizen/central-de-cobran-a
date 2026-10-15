import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolvePublicSettings} from './public-settings.mjs';
const fixture={supabaseUrl:'https://test-project.supabase.co',supabasePublishableKey:'sb_publishable_SyntheticPublicKey01234567890'};
test('clean checkout uses only the public project settings without environment variables',async()=>{
 const defaults=JSON.parse(await readFile(new URL('./supabase.public.json',import.meta.url),'utf8'));
 const result=resolvePublicSettings({},defaults);
 assert.equal(result.supabaseUrl,defaults.supabaseUrl);assert.equal(result.publishableKey,defaults.supabasePublishableKey);
 assert.deepEqual(Object.keys(result).sort(),['publishableKey','supabaseUrl']);
});
test('explicit public deployment variables override the default project',()=>{
 const value=resolvePublicSettings({NEXT_PUBLIC_SUPABASE_URL:fixture.supabaseUrl+'/',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:fixture.supabasePublishableKey,UNRELATED_SERVER_SECRET:'synthetic-not-exposed'},{});
 assert.equal(value.supabaseUrl,fixture.supabaseUrl);assert.equal(value.publishableKey,fixture.supabasePublishableKey);assert(!JSON.stringify(value).includes('synthetic-not-exposed'));
});
test('private keys and legacy JWTs are rejected before the frontend is bundled',()=>{
 for(const invalid of ['sb_secret_synthetic_private_key','eyJsyntheticServiceRoleJwt','']){
  assert.throws(()=>resolvePublicSettings({NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:invalid},{...fixture,supabasePublishableKey:invalid}),/somente a chave pública/);
 }
});
test('connection settings cannot include a URL password, extra path or non-HTTPS origin',()=>{
 for(const url of ['https://user:pass@test-project.supabase.co','http://test-project.supabase.co','https://test-project.supabase.co/not-an-origin']){
  assert.throws(()=>resolvePublicSettings({NEXT_PUBLIC_SUPABASE_URL:url},fixture));
 }
});
