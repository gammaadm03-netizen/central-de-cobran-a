import { createAuthGateway } from './handler.mjs';

// All three SUPABASE_* values are injected by the Supabase Edge runtime.
// ALLOWED_ORIGINS is the explicit comma-separated list of approved site origins.
Deno.serve(createAuthGateway({
  env: (name: string) => Deno.env.get(name),
  // Only fixed event identifiers are logged. Never log a request, upstream
  // response, username, password, Auth payload, token or environment variable.
  log: (event: string) => console.warn(`auth-gateway:${event}`),
}));
