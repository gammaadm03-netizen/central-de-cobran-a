/** Resolve only browser-safe settings. Never return environment objects or administrative keys. */
export function resolvePublicSettings(settings, defaults) {
  const supabaseUrl = String(settings.NEXT_PUBLIC_SUPABASE_URL || settings.VITE_SUPABASE_URL || defaults.supabaseUrl || '').trim();
  const publishableKey = String(settings.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || settings.VITE_SUPABASE_PUBLISHABLE_KEY || defaults.supabasePublishableKey || '').trim();
  let url;
  try { url = new URL(supabaseUrl); } catch { throw new Error('A URL pública do Supabase não está configurada corretamente.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
      || url.username || url.password || url.port || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new Error('A URL pública do Supabase precisa apontar para o projeto HTTPS.');
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(publishableKey)) {
    // Do not print the supplied value: it may be an accidentally entered server secret.
    throw new Error('Use somente a chave pública sb_publishable_ na configuração do site.');
  }
  return { supabaseUrl: url.origin, publishableKey };
}
