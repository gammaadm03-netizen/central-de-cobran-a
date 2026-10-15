export type RecoveryLink = {
  accessToken: string;
  refreshToken: string;
  valid: boolean;
};

// Ler uma única vez, antes de renderizar a aplicação. Nenhum token é salvo no navegador.
export function consumeRecoveryLink(): RecoveryLink | null {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const requested = url.searchParams.has('password-reset') || fragment.get('type') === 'recovery';
  const hasCredentials = fragment.has('access_token') || fragment.has('refresh_token');
  const hasError = fragment.has('error') || fragment.has('error_code');
  if (!requested && !hasCredentials && !hasError) return null;

  const accessToken = fragment.get('access_token') ?? '';
  const refreshToken = fragment.get('refresh_token') ?? '';
  const valid = fragment.get('type') === 'recovery' && Boolean(accessToken && refreshToken) && !hasError;
  url.hash = '';
  url.searchParams.delete('password-reset');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  return { accessToken, refreshToken, valid };
}
