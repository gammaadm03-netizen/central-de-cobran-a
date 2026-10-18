import { build } from 'esbuild';

await build({
  entryPoints: ['supabase/functions/collection-reference-import/index.ts'],
  outfile: 'supabase/dashboard/collection-reference-import.ts',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: false,
  legalComments: 'none',
});
console.log('Generated collection reference gateway; no remote deployment performed.');
