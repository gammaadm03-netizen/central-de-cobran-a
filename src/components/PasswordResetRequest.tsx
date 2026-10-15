import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authGateway, isConfigured } from '../lib/supabase';

const sentMessage = 'Se o acesso estiver ativo, enviaremos as instruções de redefinição ao e-mail cadastrado.';

export default function PasswordResetRequest({ initialUsername, onBack }: { initialUsername: string; onBack: () => void }) {
  const [username, setUsername] = useState(initialUsername);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { activeRequest.current?.abort(); activeRequest.current = null; }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!username.trim()) { setError('Informe seu usuário da Central.'); return; }
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    try {
      const response = await authGateway({ action: 'request_password_reset', username: username.trim() }, undefined, controller.signal);
      if (controller.signal.aborted) return;
      if (response.status === 202) setSent(true);
      else setError(response.status === 429 ? 'Muitas solicitações. Aguarde alguns minutos e tente novamente.' : response.status === 400 ? 'Confira o usuário informado e tente novamente.' : 'Não foi possível solicitar a redefinição agora. Tente novamente mais tarde.');
    } catch {
      if (!controller.signal.aborted) setError('Não foi possível conectar à Central. Verifique sua conexão e tente novamente.');
    } finally {
      if (activeRequest.current === controller) { activeRequest.current = null; setBusy(false); }
    }
  }

  return <>
    <span className="eyebrow">RECUPERAR ACESSO</span><h2>Esqueci minha senha</h2>
    <p className="muted">Informe seu usuário da Central para receber as instruções por e-mail.</p>
    {sent ? <><p className="notice" role="status">{sentMessage}</p><p className="help-text">Confira sua caixa de entrada e a pasta de spam. Se precisar de ajuda com o e-mail cadastrado, procure a Gerência Geral.</p></> : <form className="stack" onSubmit={submit} aria-busy={busy}>
      <label className="field">Usuário<input name="reset-username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64} required value={username} onChange={event => setUsername(event.target.value)} disabled={busy} placeholder="Seu usuário" /></label>
      {error && <p className="alert error" role="alert">{error}</p>}
      <button className="button primary login-submit" type="submit" disabled={busy || !isConfigured}>{busy ? 'Solicitando…' : 'Enviar instruções'}</button>
    </form>}
    <button className="login-link" type="button" onClick={() => { activeRequest.current?.abort(); onBack(); }}>Voltar ao login</button>
  </>;
}
