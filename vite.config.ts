import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const settings = loadEnv(mode, '.', '');
  // Expose exactly two public settings; never forward the process environment.
  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(settings.NEXT_PUBLIC_SUPABASE_URL || settings.VITE_SUPABASE_URL || ''),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(settings.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || settings.VITE_SUPABASE_PUBLISHABLE_KEY || ''),
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
  };
});
