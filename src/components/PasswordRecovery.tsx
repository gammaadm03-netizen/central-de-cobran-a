import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authGateway, createRecoveryClient } from '../lib/supabase';
import type { RecoveryLink } from '../lib/passwordRecovery';

const invalidLink = 'Este link de redefinição é inválido ou expirou. Volte ao login e solicite um novo link.';

export default function PasswordRecovery({ link, onFinish }: { link: RecoveryLink; onFinish: (notice: string) => void }) {
  const [client] = useState(createRecoveryClient);
  const [status, setStatus] = useState<'checking' | 'ready' | 'invalid' | 'uncertain'>(link.valid ? 'checking' : 'invalid');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const verified = useRef(false);
  const validation = useRef<Promise<boolean> | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const finished = useRef(false);

  useEffect(() => {
    let active = true;
    if (!link.valid || !client) { setStatus('invalid'); return; }
    // Reutilizar a verificação durante a repetição de efeitos do React StrictMode.
    if (!validation.current) {
      const accessToken = link.accessToken;
      const refreshToken = link.refreshToken;
      link.accessToken = '';
      link.refreshToken = '';
      validation.current = (async () => {
        try {
          const result = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          if (result.error || !result.data.session) return false;
          const user = await client.auth.getUser();
          return !user.error && Boolean(user.data.user) && user.data.user?.id === result.data.user?.id;
        } catch { return false; }
      })();
    }
    void validation.current.then(valid => {
      if (!active || finished.current) return;
      verified.current = valid;
      setStatus(valid ? 'ready' : 'invalid');
    });
    return () => { active = false; };
  }, [client, link]);

  useEffect(() => () => { activeRequest.current?.abort(); }, []);

  function finish(notice: string) {
    finished.current = true;
    verified.current = false;
    activeRequest.current?.abort();
    link.accessToken = '';
    link.refreshToken = '';
    client?.auth.stopAutoRefresh();
    setPassword('');
    setConfirmation('');
    // Encerrar a sessão de recuperação, que nunca concede acesso ao painel.
    if (client) void client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    onFinish(notice);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!verified.current || !client || busy) return;
    if (password.length < 12 || password.length > 1024) { setError('Use uma senha com 12 a 1.024 caracteres.'); return; }
    if (password !== confirmation) { setError('As senhas precisam ser iguais.'); return; }
    if (!window.confirm('Confirmar a alteração da sua senha? Após salvar, entre novamente na Central com a nova senha.')) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    try {
      const session = await client.auth.getSession();
      if (controller.signal.aborted || finished.current) return;
      const token = session.data.session?.access_token;
      if (session.error || !token) { verified.current = false; setStatus('invalid'); return; }
      const response = await authGateway({ action: 'change_password', password }, token, controller.signal);
      if (controller.signal.aborted || finished.current) return;
      if (response.ok) {
        finish('Sua senha foi alterada. Entre na Central com a nova senha.');
      } else if (response.status === 401) {
        verified.current = false;
        setStatus('invalid');
      } else if (response.status === 400) {
        setError('A senha não foi aceita. Use pelo menos 12 caracteres e escolha uma senha diferente da anterior.');
      } else if (response.status === 429) {
        setError('Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.');
      } else {
        verified.current = false;
        setStatus('uncertain');
      }
    } catch {
      if (!controller.signal.aborted && !finished.current) {
        verified.current = false;
        setStatus('uncertain');
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      if (!finished.current) { setPassword(''); setConfirmation(''); setBusy(false); }
    }
  }

  return <main className="recovery-shell"><section className="login-card recovery-card" aria-busy={status === 'checking' || busy}>
    <span className="eyebrow">CENTRAL FINANCEIRA · GRUPO ECOPLAST</span>
    <h1>Redefinir senha</h1>
    {status === 'checking' && <p className="notice" role="status">Verificando seu link de redefinição…</p>}
    {status === 'invalid' && <p className="alert error" role="alert">{invalidLink}</p>}
    {status === 'uncertain' && <p className="alert error" role="alert">Não foi possível confirmar a conclusão. A senha pode ter sido alterada. Volte ao login e solicite um novo link para concluir a redefinição com segurança.</p>}
    {status === 'ready' && <>
      <p className="muted">Defina uma nova senha para seu acesso individual.</p>
      <form className="stack" onSubmit={submit}>
        <label className="field">Nova senha<input name="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
        <label className="field">Confirmar nova senha<input name="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label>
        <p className="help-text">Use pelo menos 12 caracteres. Não compartilhe sua senha.</p>
        {error && <p className="alert error" role="alert">{error}</p>}
        <button className="button primary" type="submit" disabled={busy}>{busy ? 'Salvando…' : 'Salvar nova senha'}</button>
      </form>
    </>}
    <button className="login-link" type="button" disabled={busy} onClick={() => finish('')}>Voltar ao login</button>
  </section></main>;
}
