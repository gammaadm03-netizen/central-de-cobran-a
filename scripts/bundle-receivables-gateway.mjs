import { build } from 'esbuild';

await build({
  entryPoints: ['supabase/functions/receivables-import/index.ts'],
  outfile: 'supabase/dashboard/receivables-import.ts',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['npm:*'],
  minify: false,
  legalComments: 'none',
});
console.log('Generated receivables import gateway; no remote deployment performed.');
