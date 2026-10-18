import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { authGateway, clearClientSession, isConfigured, supabase } from './lib/supabase';
import { isAccess, permits, roleNames, type Access } from './lib/access';
import ManagementMessages from './components/ManagementMessages';
import Administration from './components/Administration';
import ExecutiveDashboard from './components/ExecutiveDashboard';
import Treasury from './components/Treasury';
import Payables from './components/Payables';
import ImportsHub from './components/ImportsHub';
import Receivables from './components/Receivables';
import Collections from './components/Collections';
import ReceivableCommissions from './components/ReceivableCommissions';
import PasswordRecovery from './components/PasswordRecovery';
import PasswordResetRequest from './components/PasswordResetRequest';
import { consumeRecoveryLink } from './lib/passwordRecovery';
import { version } from '../package.json';

// Consumir o fragmento antes de qualquer render ou requisição da aplicação.
let initialRecoveryLink = consumeRecoveryLink();

const modules = [
  { id: 'painel', label: 'Painel Gerencial', icon: '▦', description: 'Visão executiva e indicadores consolidados.' },
  { id: 'caixa', label: 'Caixa / Bancos', icon: '▤', description: 'Posição das contas bancárias do grupo.' },
  { id: 'contas_pagar', label: 'Contas a Pagar', icon: '↗', description: 'Obrigações e planejamento financeiro.' },
  { id: 'contas_receber', label: 'Contas a Receber', icon: '↙', description: 'Títulos e validação de recebimentos.' },
  { id: 'cobranca', label: 'Cobrança', icon: '◉', description: 'Acompanhamento de contatos e carteira individual.' },
  { id: 'comissoes', label: 'Comissões', icon: '%', description: 'Regras e apuração com histórico de vigência.' },
  { id: 'faturamento', label: 'Faturamento', icon: '▥', description: 'Receita e acompanhamento de metas.' },
  { id: 'margens', label: 'Margens', icon: '◷', description: 'Custos e resultado líquido das vendas.' },
  { id: 'rh_dp', label: 'RH / DP', icon: '♙', description: 'Equipe, folha e benefícios.' },
  { id: 'importar_bases', label: 'Importar Bases', icon: '⇧', description: 'Atualização centralizada das bases oficiais.' },
];

function Brand({ onClick }: { onClick?: () => void }) {
  const inner = <><span className="brand-mark" aria-hidden="true"><img src="/ecoplast-logo.png" alt="" width="58" height="58" /></span><span className="brand-copy"><strong>Central Financeira</strong><small>GRUPO ECOPLAST</small></span></>;
  return onClick ? <button type="button" className="brand" onClick={onClick} aria-label="Central Financeira — início">{inner}</button> : <div className="brand">{inner}</div>;
}

function Login({ onLogin, notice }: { onLogin: (username: string, password: string) => Promise<void>; notice: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestingReset, setRequestingReset] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!username.trim() || !password) return setError('Informe seu usuário e sua senha.');
    setBusy(true);
    try { await onLogin(username.trim(), password); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível entrar. Tente novamente.'); }
    finally { setPassword(''); setBusy(false); }
  }
  return <main className="login-shell"><section className="login-intro"><Brand /><div className="intro-copy"><span className="eyebrow">GESTÃO COM RESPONSABILIDADE</span><h1>As informações certas.<br />Em um só lugar.</h1><p>Acesso à Central Financeira do Grupo Ecoplast, com permissões individuais e histórico de operações.</p><div className="intro-line" /><p className="intro-foot">Integridade dos dados · Segurança · Rastreabilidade</p></div><small>Central Financeira · Versão {version}</small></section><section className="login-main"><div className="login-card">{requestingReset ? <PasswordResetRequest initialUsername={username} onBack={() => setRequestingReset(false)} /> : <><span className="eyebrow">ÁREA RESTRITA</span><h2>Bem-vindo à Central</h2><p className="muted">Informe suas credenciais para continuar.</p>{notice && <p className="notice" role="status">{notice}</p>}{!isConfigured && <p className="alert error" role="alert">A conexão da Central ainda não foi configurada. Entre em contato com a administração.</p>}<form onSubmit={submit} className="stack"><label className="field">Usuário<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={64} value={username} onChange={event => setUsername(event.target.value)} disabled={busy} placeholder="Seu usuário" /></label><label className="field">Senha<input name="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} placeholder="Sua senha" /></label>{error && <p className="alert error" role="alert">{error}</p>}<button className="button primary login-submit" type="submit" disabled={busy || !isConfigured}>{busy ? 'Entrando…' : 'Entrar na Central'}<span aria-hidden="true">→</span></button></form><button className="login-link" type="button" disabled={busy || !isConfigured} onClick={() => { setPassword(''); setError(''); setRequestingReset(true); }}>Esqueci minha senha</button><p className="login-help">Precisa de acesso?<br />Procure a Gerência Geral.</p></>}</div><small className="login-footer">Sessão individual · Não compartilhe suas credenciais</small></section></main>;
}

function PendingModule({ id, collectorId }: { id: string; collectorId: string | null }) {
  const module = modules.find(item => item.id === id)!;
  return <section className="panel pending-panel"><span className="feature-symbol" aria-hidden="true">{module.icon}</span><span className="badge">EM PREPARAÇÃO</span><h2>{module.label}</h2><p>{module.description}</p><p className="muted">Este módulo ainda não está disponível nesta versão. As bases financeiras da Central anterior precisam ser migradas e validadas antes de iniciar a operação.</p>{id === 'cobranca' && !collectorId && <p className="notice">Para perfis de cobrança, a Gerência Geral também precisa vincular o login à pessoa responsável. Nenhuma carteira é atribuída automaticamente.</p>}<p className="pending-foot">Nenhum lançamento ou valor financeiro é apresentado sem uma base oficial validada.</p></section>;
}

export default function App() {
  const [recovery, setRecovery] = useState(initialRecoveryLink);
  const [initialNotice, setInitialNotice] = useState('');
  useEffect(() => { initialRecoveryLink = null; }, []);
  if (recovery) return <PasswordRecovery link={recovery} onFinish={message => { clearClientSession(); setInitialNotice(message); setRecovery(null); }} />;
  return <CentralApp initialNotice={initialNotice} />;
}

function CentralApp({ initialNotice }: { initialNotice: string }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [selected, setSelected] = useState('painel');
  const [importArea, setImportArea] = useState('contas_pagar');
  const [notice, setNotice] = useState(initialNotice);
  const [busyLogout, setBusyLogout] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [clientRevision, setClientRevision] = useState(0);
  const loggingOut = useRef(false);
  const sessionGeneration = useRef(0);
  const refreshInFlight = useRef(false);
  const accessRef = useRef(access);
  accessRef.current = access;

  function endLocalSession(message: string) {
    sessionGeneration.current += 1;
    setAccess(null);
    accessRef.current = null;
    setNotice(message);
    clearClientSession();
    setClientRevision(value => value + 1);
    setMobileOpen(false);
  }

  async function reloadAccess() {
    if (!supabase || refreshInFlight.current || loggingOut.current) return;
    const client = supabase;
    const generation = sessionGeneration.current;
    refreshInFlight.current = true;
    try {
      const { data, error } = await client.rpc('current_access');
      if (client !== supabase || generation !== sessionGeneration.current || loggingOut.current) return;
      if (error || !isAccess(data)) { endLocalSession('Sua sessão expirou ou seu acesso foi alterado. Entre novamente.'); return; }
      setAccess(data);
    } catch { if (client === supabase && generation === sessionGeneration.current && !loggingOut.current) endLocalSession('Não foi possível verificar sua sessão. Entre novamente para continuar.'); }
    finally { refreshInFlight.current = false; }
  }

  useEffect(() => {
    const client = supabase;
    if (!client) return;
    const { data: listener } = client.auth.onAuthStateChange(event => {
      if (loggingOut.current) return;
      if (event === 'SIGNED_OUT' && accessRef.current) endLocalSession('Sua sessão expirou. Entre novamente.');
      // Não aguardar RPCs dentro do callback de autenticação.
      if (event === 'TOKEN_REFRESHED' && accessRef.current) window.setTimeout(() => void reloadAccess(), 0);
    });
    const refreshOnFocus = () => { if (accessRef.current) void reloadAccess(); };
    window.addEventListener('focus', refreshOnFocus);
    const timer = window.setInterval(refreshOnFocus, 60000);
    return () => { listener.subscription.unsubscribe(); window.removeEventListener('focus', refreshOnFocus); window.clearInterval(timer); };
    // O cliente é recriado para remover integralmente as credenciais da memória.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientRevision]);

  async function signIn(username: string, password: string) {
    const client = supabase;
    if (!client) throw new Error('A conexão da Central ainda não está disponível.');
    const generation = ++sessionGeneration.current;
    let response: Response;
    try { response = await authGateway({ action: 'sign_in', username, password }); }
    catch { throw new Error('Não foi possível conectar à Central. Verifique sua conexão e tente novamente.'); }
    if (!response.ok) throw new Error(response.status === 429 ? 'Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.' : response.status === 401 || response.status === 400 ? 'Usuário ou senha inválidos, ou acesso indisponível.' : 'O serviço de acesso está temporariamente indisponível. Tente novamente.');
    let payload;
    try { payload = await response.json(); } catch { throw new Error('O serviço de acesso está indisponível. Tente novamente.'); }
    if (!payload || typeof payload !== 'object' || typeof payload.session?.access_token !== 'string' || typeof payload.session?.refresh_token !== 'string') throw new Error('Não foi possível iniciar a sessão. Tente novamente.');
    try {
      const { error } = await client.auth.setSession({ access_token: payload.session.access_token, refresh_token: payload.session.refresh_token });
      if (client !== supabase || generation !== sessionGeneration.current || loggingOut.current) return;
      if (error) throw new Error('Não foi possível iniciar a sessão. Tente novamente.');
      const result = await client.rpc('current_access');
      if (client !== supabase || generation !== sessionGeneration.current || loggingOut.current) return;
      if (result.error || !isAccess(result.data)) throw new Error('Seu acesso ainda não foi habilitado. Procure a Gerência Geral.');
      const nextAccess = result.data;
      setAccess(nextAccess);
      setSelected(modules.find(module => permits(nextAccess, module.id))?.id ?? '');
      setNotice('');
    } catch {
      if (client === supabase && generation === sessionGeneration.current) endLocalSession('');
      throw new Error('Não foi possível verificar seu acesso. Tente novamente ou procure a Gerência Geral.');
    }
  }

  async function logout() {
    if (loggingOut.current) return;
    loggingOut.current = true;
    setBusyLogout(true);
    let revoked = false;
    try {
      const result = await supabase?.auth.getSession();
      const token = result?.data.session?.access_token;
      if (token) { const response = await authGateway({ action: 'sign_out' }, token); revoked = response.ok; }
    } catch { /* Exibir abaixo a diferença entre encerramento local e remoto. */ }
    finally {
      endLocalSession(revoked ? 'Você saiu da Central.' : 'O acesso foi encerrado nesta aba. Não foi possível confirmar a revogação remota; a sessão no servidor pode permanecer válida até expirar.');
      loggingOut.current = false;
      setBusyLogout(false);
    }
  }

  if (!access) return <Login onLogin={signIn} notice={notice} />;
  const visibleModules = modules.filter(module => permits(access, module.id));
  const isManager = permits(access, 'usuarios', 'admin') && access.profile.role_key === 'gerente_geral';
  const activeModule = visibleModules.find(module => module.id === selected);
  const safeSelected = activeModule ? selected : isManager && selected === 'administracao' ? selected : visibleModules[0]?.id ?? '';
  const title = safeSelected === 'administracao' ? 'Administração' : modules.find(module => module.id === safeSelected)?.label ?? 'Acesso à Central';
  function navigate(id: string) { setSelected(id); setMobileOpen(false); }
  let content: ReactNode;
  if (safeSelected === 'administracao' && isManager) content = <Administration onAccessChanged={reloadAccess} />;
  else if (safeSelected === 'painel') content = <ExecutiveDashboard canManage={isManager && permits(access, 'resumo_diretoria', 'write')} canReadDirectorSummary={permits(access, 'resumo_diretoria')} canViewPayables={permits(access, 'contas_pagar')} canViewCash={permits(access, 'caixa')} canViewReceivables={permits(access, 'contas_receber')} onDirectorInputs={isManager && permits(access, 'resumo_diretoria', 'write') && permits(access, 'importar_bases') ? () => { setImportArea('resumo_diretoria'); navigate('importar_bases'); } : undefined} onNavigate={navigate} />;
  else if (safeSelected === 'caixa') content = <Treasury canWrite={permits(access, 'caixa', 'write')} onStockImport={access.profile.role_key === 'gerente_geral' && permits(access, 'caixa', 'write') && permits(access, 'importar_bases') ? () => { setImportArea('estoque'); navigate('importar_bases'); } : undefined} />;
  else if (safeSelected === 'importar_bases') content = <ImportsHub access={access} initialArea={importArea} onDashboard={permits(access, 'painel') ? () => navigate('painel') : undefined} />;
  else if (safeSelected === 'contas_receber') content = <Receivables canWrite={permits(access, 'contas_receber', 'write')} canValidate={permits(access, 'contas_receber', 'validate')} onImport={permits(access, 'contas_receber', 'import') ? () => { setImportArea('contas_receber'); navigate('importar_bases'); } : undefined} />;
  else if (safeSelected === 'cobranca') content = <Collections canWrite={permits(access, 'cobranca', 'write')} canManage={permits(access, 'contas_receber', 'write')} collectorId={access.collector_id} isCollector={['cobradora_1', 'cobradora_2'].includes(access.profile.role_key)} />;
  else if (safeSelected === 'comissoes') content = <ReceivableCommissions />;
  else if (safeSelected === 'contas_pagar') content = <><Payables canWrite={permits(access, 'contas_pagar', 'write')} canConfigure={isManager && permits(access, 'contas_pagar', 'write')} onImport={permits(access, 'contas_pagar', 'import') ? () => { setImportArea('contas_pagar'); navigate('importar_bases'); } : undefined} />{permits(access, 'mensagens_cp') && <ManagementMessages canWrite={permits(access, 'mensagens_cp', 'write')} />}</>;
  else if (safeSelected) content = <PendingModule id={safeSelected} collectorId={access.collector_id} />;
  else content = <section className="panel"><h2>Nenhum módulo autorizado</h2><p>Procure a Gerência Geral para revisar suas permissões.</p></section>;

  return <div className="app-shell">{mobileOpen && <button className="sidebar-backdrop" aria-label="Fechar navegação" onClick={() => setMobileOpen(false)} />}<aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}><Brand onClick={() => navigate(visibleModules.find(module => module.id === 'painel')?.id ?? visibleModules[0]?.id ?? '')} /><span className="nav-label">ESPAÇO DE TRABALHO</span><nav aria-label="Módulos da Central">{visibleModules.map(module => <button key={module.id} className={`nav-item ${safeSelected === module.id ? 'active' : ''}`} onClick={() => navigate(module.id)} aria-current={safeSelected === module.id ? 'page' : undefined}><span className="nav-icon" aria-hidden="true">{module.icon}</span>{module.label}</button>)}</nav>{isManager && <div className="admin-nav"><span className="nav-label">GESTÃO DO SISTEMA</span><button className={`nav-item ${safeSelected === 'administracao' ? 'active' : ''}`} onClick={() => navigate('administracao')}><span className="nav-icon" aria-hidden="true">⚙</span>Administração</button></div>}<div className="sidebar-footer"><span className="small-shield">✓</span><div>Acesso individual<small>Permissões verificadas no banco</small></div></div></aside><div className="main-shell"><header className="topbar"><div className="topbar-title"><button className="menu-button" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Abrir navegação" aria-expanded={mobileOpen}>☰</button><span>Central Financeira <span className="breadcrumb-separator">/</span> <strong>{title}</strong></span></div><div className="user-menu"><span className="avatar" aria-hidden="true">{access.profile.display_name.slice(0, 1).toUpperCase()}</span><div><strong>{access.profile.display_name}</strong><small>{roleNames[access.profile.role_key]}</small></div><button className="logout-button" disabled={busyLogout} onClick={() => void logout()}>{busyLogout ? 'Saindo…' : 'Sair'}<span aria-hidden="true">↪</span></button></div></header><main className="workspace"><div className="page-heading"><div><span className="eyebrow">GRUPO ECOPLAST</span><h1>{title}</h1></div><span className="time-zone">Horário oficial · Brasília</span></div>{content}</main><footer className="app-footer"><span>Central Financeira · Grupo Ecoplast</span><span>Versão {version} · America/Sao_Paulo</span></footer></div></div>;
}
