export type RecoveryLink = {
  accessToken: string;
  refreshToken: string;
  valid: boolean;
  issue: 'incomplete' | 'expired' | 'callback' | null;
};

// Ler uma única vez, antes de renderizar a aplicação. Nenhum token é salvo no navegador.
export function consumeRecoveryLink(): RecoveryLink | null {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const requested = url.searchParams.has('password-reset') || fragment.get('type') === 'recovery';
  const hasCredentials = fragment.has('access_token') || fragment.has('refresh_token');
  const hasError = ['error', 'error_code', 'error_description'].some(key => fragment.has(key) || url.searchParams.has(key));
  if (!requested && !hasCredentials && !hasError) return null;

  const accessToken = fragment.get('access_token') ?? '';
  const refreshToken = fragment.get('refresh_token') ?? '';
  const valid = fragment.get('type') === 'recovery' && Boolean(accessToken && refreshToken) && !hasError;
  const providerCode = fragment.get('error_code') ?? url.searchParams.get('error_code');
  // Classify only known codes. Never display or log arbitrary callback text.
  const issue = hasError ? (providerCode === 'otp_expired' ? 'expired' : 'callback') : valid ? null : 'incomplete';
  url.hash = '';
  for (const key of ['password-reset', 'error', 'error_code', 'error_description', 'access_token', 'refresh_token', 'token', 'token_hash', 'code']) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  return { accessToken, refreshToken, valid, issue };
}
