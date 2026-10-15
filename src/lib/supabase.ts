import { createClient } from '@supabase/supabase-js';

export const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const publishableKey = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '');
export const isConfigured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl) && /^(sb_publishable_|eyJ)/.test(publishableKey);

function createMemoryClient() {
  return isConfigured ? createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  }) : null;
}

// Sessões ficam somente na memória da aba. Dados financeiros nunca usam localStorage.
export let supabase = createMemoryClient();
export function clearClientSession() {
  supabase?.auth.stopAutoRefresh();
  supabase = createMemoryClient();
}

export async function authGateway(body: Record<string, unknown>, accessToken?: string) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(`${supabaseUrl}/functions/v1/auth-gateway`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: publishableKey, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
  } finally {
    window.clearTimeout(timer);
  }
}
