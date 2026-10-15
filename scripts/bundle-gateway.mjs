import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
await mkdir('artifacts',{recursive:true});
await build({entryPoints:['supabase/functions/auth-gateway/index.ts'],bundle:true,platform:'neutral',format:'esm',target:'es2022',outfile:'artifacts/auth-gateway-dashboard.ts'});
console.log('Generated artifacts/auth-gateway-dashboard.ts for review; no deployment performed.');
