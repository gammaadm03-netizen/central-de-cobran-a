import { build } from 'esbuild';

await build({
  entryPoints: ['supabase/functions/payables-import/index.ts'],
  outfile: 'supabase/dashboard/payables-import.ts',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['npm:*'],
  minify: false,
  legalComments: 'none',
});
console.log('Generated single-file payables gateway for dashboard publication; no deployment performed.');
