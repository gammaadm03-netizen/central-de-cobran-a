import { readFileSync } from 'node:fs';
import { resolvePublicSettings } from './config/public-settings.mjs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const settings = loadEnv(mode, '.', ['NEXT_PUBLIC_SUPABASE_', 'VITE_SUPABASE_']);
  const defaults = JSON.parse(readFileSync(new URL('./config/supabase.public.json', import.meta.url), 'utf8'));
  const connection = resolvePublicSettings(settings, defaults);
  // Expose exactly two validated PUBLIC settings; private server keys fail the build.
  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(connection.supabaseUrl),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(connection.publishableKey),
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
  };
});
