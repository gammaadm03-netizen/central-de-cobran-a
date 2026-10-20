import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
export async function createCostFixture() {
 const db=new PGlite(), id=n=>`a4400000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const users=Object.fromEntries([['manager','gerente_geral'],['manager2','gerente_geral'],['director','diretor'],['cp','contas_pagar'],['cr','contas_receber'],['rh','rh_dp'],['collector','cobradora_1']].map(([name,role],i)=>[name,{id:id(i+1),session:id(i+11),role}]));
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.r;
 const owner=async(name='manager',session=users[name].session,extra={})=>{await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[users[name].id,JSON.stringify({sub:users[name].id,session_id:session,...extra})]);};
 const actor=async(name='manager',session=users[name].session,extra={})=>{await owner(name,session,extra);await db.exec('SET ROLE authenticated');};
 const file=name=>readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8');
 await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
 for(const name of (await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(n=>/^\d{3}_.*\.sql$/.test(n)&&Number(n.slice(0,3))<=34).sort()) {
  if(name.startsWith('028_'))await db.exec(`CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,bucket_id text,name text,metadata jsonb DEFAULT '{}',UNIQUE(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;`);
  await db.exec(await file(name));
 }
 await db.exec(await file('039_user_access_limits.sql'));
 for(const [name,u] of Object.entries(users)) {await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[u.id,`${name}-synthetic@example.invalid`]);await db.query('INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,$2,$2,$3,true)',[u.id,`CostSynthetic_${name}`,u.role]);await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)',[u.session,u.id]);}
 await owner();await scalar('SELECT cf_private.restrict_payables_user($1) r',[users.cp.id]);await actor();
 let latest=null,seq=0;
 const row=(line,code,cost='6.555',extra={})=>({line_number:line,code,product:`Produto sintético ${code}`,weight_kg:null,unit_cost:cost,...extra});
 const costPreview=(rows,reference='2026-10-20',resolutions={})=>scalar('SELECT public.preview_product_cost_import($1,$2,$3) r',[JSON.stringify(rows),reference,JSON.stringify(resolutions)]);
 const costCommit=async(rows,{reference='2026-10-20',resolutions={},source=`synthetic-cost-${++seq}`,previous=latest,user='manager',session=users[user].session}={})=>{
  const bytes=Buffer.from(source);await owner();await db.exec('SET ROLE service_role');try{const r=await scalar('SELECT public.commit_product_cost_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9) r',[users[user].id,session,'custos-sinteticos.xlsx',createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(rows),reference,previous,JSON.stringify(resolutions)]);if(!r.idempotent)latest=r.import_id;return r;}finally{await actor();}
 };
 const list=(args={})=>scalar('SELECT public.list_product_costs($1,$2,$3,$4,$5) r',[args.reference??null,args.search??'',args.offset??0,args.limit??25,args.importId??null]);
 const commercialRow=(line,code,extra={})=>({line_number:line,code,product:`Produto sintético ${code}`,client:'Cliente sintético',employee:'Vendedor sintético',invoice:`NF-SYN-${line}`,cost_center:'PRIVADO',branch:'FILIAL SINTETICA',issued_on:'2026-10-10',quantity:1,sale_cents:10000,freight_cents:100,tax_cents:500,cost_cents:5000,commission_cents:200,margin_cents:4200,margin_source:'PROVIDED',...extra});
 const commercialCommit=async(rows,{month='2026-10-01',previous=null,source=`synthetic-closing-${++seq}`}={})=>{const bytes=Buffer.from(source);await owner();await db.exec('SET ROLE service_role');try{return await scalar('SELECT public.commit_commercial_import_from_gateway($1,$2,$3,$4,$5,$6,$7,$8) r',[users.manager.id,users.manager.session,'fechamento-sintetico.xlsx',createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(rows),month,previous]);}finally{await actor();}};
 const snapshot=async()=>{await owner();const names=(await db.query("SELECT schemaname||'.'||tablename name FROM pg_tables WHERE schemaname IN('public','cf_private','auth') ORDER BY 1")).rows.map(r=>r.name);const result={};for(const n of names)result[n]=(await db.query(`SELECT to_jsonb(t) r FROM ${n} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.r);return result;};
 return {db,users,id,scalar,owner,actor,file,row,costPreview,costCommit,list,commercialRow,commercialCommit,snapshot,get latest(){return latest;}};
}
