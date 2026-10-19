import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRemainingModulesSql, writeRemainingModulesBundle } from './bundle-remaining-modules.mjs';

const db = new PGlite();
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
const bundle = await writeRemainingModulesBundle();
try {
  await assert.rejects(() => db.exec(bundle), error => error.code === '22023');
  await db.exec('ROLLBACK');
  assert.equal(await scalar("SELECT to_regclass('public.commercial_items')::text AS value"), null);
  console.log('PASS activation fails atomically without the existing Central base');
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,banned_until timestamptz,deleted_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;`);
  const names = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
    .filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) < 31).sort();
  for (const name of names) {
    if (name.startsWith('028_')) await db.exec(`CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,bucket_id text,name text,metadata jsonb DEFAULT '{}',UNIQUE(bucket_id,name));
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;
      GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;`);
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  const user = '83000000-0000-4000-8000-000000000001', session = '83000000-0000-4000-8000-000000000002';
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,'synthetic@example.invalid')", [user]);
  await db.query("INSERT INTO public.profiles(id,username,display_name,role_key,enabled) VALUES($1,'PessoaSintetica','Pessoa sintética','gerente_geral',true)", [user]);
  await db.query('INSERT INTO cf_private.approved_sessions(session_id,user_id) VALUES($1,$2)', [session, user]);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [user, JSON.stringify({ session_id: session })]);
  await db.exec('SET ROLE authenticated');
  await db.query("SELECT public.save_manual_stock(123456,(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,'Posição sintética preservada')");
  await db.exec('RESET ROLE');
  const state = async () => {
    const tables = (await db.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname IN('auth','public','cf_private','storage') ORDER BY schemaname,tablename")).rows;
    const result = {};
    for (const { name } of tables) result[name] = await scalar(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS value FROM ${name} t`);
    return result;
  };
  const before = await state();
  await db.exec(bundle);
  const after = await state();
  for (const [table, rows] of Object.entries(before)) {
    if (!['public.role_permissions', 'public.audit_events', 'public.central_schema_migrations', 'cf_private.collection_context_state'].includes(table)) {
      assert.deepEqual(after[table], rows, `Activation must preserve ${table}`);
    }
  }
  for (const name of ['031_director_readonly', '032_commercial', '033_hr', '034_commissions', '035_hr_report_model', '036_hr_total', '037_hr_prolabore']) {
    assert.equal(await scalar('SELECT count(*)::int AS value FROM public.central_schema_migrations WHERE version=$1', [name]), 1);
  }
  console.log('PASS combined activation installs all seven versions and preserves existing operational data');
  await db.exec(bundle);
  assert.deepEqual(await state(), after);
  console.log('PASS repeating the activation changes no data, grant, rule or audit event');
  assert.equal(await readFile(new URL('../supabase/dashboard/ativar-demais-abas.sql', import.meta.url), 'utf8'), await buildRemainingModulesSql());
  console.log('PASS dashboard SQL exactly matches the registered migration sources');
} finally { await db.close(); }
