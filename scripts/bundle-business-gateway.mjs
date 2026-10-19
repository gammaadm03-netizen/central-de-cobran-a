import { build } from 'esbuild';

await build({
  entryPoints: ['supabase/functions/business-import/index.ts'],
  outfile: 'supabase/dashboard/business-import.ts',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['npm:*'],
  legalComments: 'none',
});
console.log('Generated single-file business gateway; no remote deployment performed.');
