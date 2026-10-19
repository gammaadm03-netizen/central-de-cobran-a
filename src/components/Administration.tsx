import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';

const PAGE_SIZE = 25;
const roles = {
  diretor: 'Diretor',
  gerente_geral: 'Gerente Geral',
  contas_receber: 'Contas a Receber',
  contas_pagar: 'Contas a Pagar',
  rh_dp: 'RH / DP',
  cobradora_1: 'Cobradora 1',
  cobradora_2: 'Cobradora 2',
};
type Role = keyof typeof roles;
interface ProfileRow {
  id: string;
  username: string;
  display_name: string;
  role_key: Role;
  enabled: boolean;
  updated_at: string;
}
interface Agent {
  id: string;
  display_name: string;
  enabled: boolean;
  updated_at: string;
}
interface Binding { user_id: string; agent_id: string }
interface AuditEvent {
  id: string;
  occurred_at: string;
  username: string | null;
  role_key: string | null;
  module: string;
  entity: string;
  record_id: string | null;
  action: string;
}

function localDate(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo',
  }).format(new Date(value));
}

function friendlyError(error: unknown, fallback: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code) : '';
  if (code === '42501') return 'Sua sessão não tem autorização para esta operação. Atualize o acesso ou entre novamente.';
  if (code === '23505') return 'Já existe um usuário com esse login ou essa cobradora já está vinculada a outro acesso.';
  if (code === '23503') return 'A conta informada ainda não existe na autenticação. Confira o identificador da conta.';
  if (code === '23514') return 'A alteração não atende às regras do cadastro. Mantenha uma Gerência Geral ativa e remova o vínculo da cobradora antes de mudar seu perfil.';
  return fallback;
}

function Feedback({ error, success }: { error: string; success: string }) {
  return <>
    {error && <div className="alert error" role="alert">{error}</div>}
    {success && <div className="alert success" role="status">{success}</div>}
  </>;
}

function Pagination({ page, count, busy, onPage }: {
  page: number; count: number; busy: boolean; onPage: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  return <div className="pagination">
    <span>{count} registro(s) · Página {page + 1} de {totalPages}</span>
    <div className="inline-actions">
      <button className="button button-secondary" disabled={busy || page === 0} onClick={() => onPage(page - 1)}>Anterior</button>
      <button className="button button-secondary" disabled={busy || page + 1 >= totalPages} onClick={() => onPage(page + 1)}>Próxima</button>
    </div>
  </div>;
}

function Users({ onAccessChanged, canManage }: { onAccessChanged: () => Promise<void>; canManage: boolean }) {
  const [rows, setRows] = useState<ProfileRow[]>([]);
  const [page, setPage] = useState(0);
  const [count, setCount] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editing, setEditing] = useState<ProfileRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [uid, setUid] = useState('');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('contas_receber');
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    const client = supabase;
    setLoading(true);
    setError('');
    async function load() {
      try {
        if (!client) throw new Error('missing_client');
        const result = await client.from('profiles')
          .select('id,username,display_name,role_key,enabled,updated_at', { count: 'exact' })
          .order('username').range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        if (result.error) throw result.error;
        if (active) {
          setRows((result.data ?? []) as ProfileRow[]);
          setCount(result.count ?? 0);
        }
      } catch (failure) {
        if (active) { setRows([]); setError(friendlyError(failure, 'Não foi possível carregar os usuários. Tente novamente.')); }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [page, revision]);

  function openEditor(profile: ProfileRow | null) {
    if (!canManage || saving) return;
    setEditing(profile);
    setCreating(profile === null);
    setUid(profile?.id ?? '');
    setUsername(profile?.username ?? '');
    setName(profile?.display_name ?? '');
    setRole(profile?.role_key ?? 'contas_receber');
    setEnabled(profile?.enabled ?? false);
    setSuccess('');
    setError('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || saving) return;
    setError('');
    setSuccess('');
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username.trim()) || !name.trim() || name.trim().length > 150) {
      setError('Informe nome válido e login com 3 a 64 letras, números, ponto, hífen ou sublinhado.');
      return;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid.trim())) {
      setError('Informe o User UID completo da conta já criada na autenticação.');
      return;
    }
    if (!window.confirm(`Confirmar o cadastro de acesso?\n\nLogin: ${username.trim()}\nNome: ${name.trim()}\nPerfil: ${roles[role]}\nStatus: ${enabled ? 'Ativo' : 'Bloqueado'}\n\nAs permissões desse usuário serão aplicadas pelo banco.`)) return;
    setSaving(true);
    try {
      const client = supabase;
      if (!client) throw new Error('missing_client');
      const result = await client.rpc('manage_profile', {
        p_user_id: uid.trim(), p_username: username.trim(), p_display_name: name.trim(),
        p_role_key: role, p_enabled: enabled,
      });
      if (result.error) throw result.error;
      setEditing(null);
      setCreating(false);
      setSuccess('Cadastro salvo. As permissões foram atualizadas e a alteração registrada na auditoria.');
      setRevision(value => value + 1);
      try { await onAccessChanged(); }
      catch { setError('O cadastro foi salvo. Atualize a página para consultar suas permissões atuais.'); }
    } catch (failure) {
      setError(friendlyError(failure, 'Não foi possível salvar o cadastro. Confira o acesso e tente novamente.'));
    } finally { setSaving(false); }
  }

  return <div className="stack">
    <div className="panel-heading">
      <div><h2>Usuários e permissões</h2><p className="muted">Contas individuais com autorização validada no banco.</p></div>
      <div className="inline-actions">
        <button className="button button-secondary" disabled={loading || saving} onClick={() => setRevision(value => value + 1)}>Atualizar</button>
        {canManage && <button className="button" disabled={saving} onClick={() => openEditor(null)}>Vincular conta existente</button>}
      </div>
    </div>
    <Feedback error={error} success={success} />
    <p className="muted">A criação de contas e a redefinição de senha permanecem no painel seguro de autenticação. Esta tela não recebe nem exibe senhas.</p>
    {canManage && (editing || creating) && <form className="panel stack" onSubmit={event => { void save(event); }}>
      <h3>{creating ? 'Vincular conta de autenticação' : `Editar ${editing?.username}`}</h3>
      <fieldset disabled={saving}>
        <div className="field-grid">
          {creating && <label className="field">User UID da conta existente<input required value={uid} onChange={event => setUid(event.target.value)} maxLength={36} autoComplete="off" placeholder="Identificador da conta na autenticação" /></label>}
          <label className="field">Usuário<input required value={username} onChange={event => setUsername(event.target.value)} minLength={3} maxLength={64} pattern="[A-Za-z0-9._\-]{3,64}" autoComplete="off" /></label>
          <label className="field">Nome<input required value={name} onChange={event => setName(event.target.value)} maxLength={150} autoComplete="off" /></label>
          <label className="field">Perfil<select value={role} onChange={event => setRole(event.target.value as Role)}>{Object.entries(roles).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
          <label className="field">Status<select value={enabled ? 'enabled' : 'blocked'} onChange={event => setEnabled(event.target.value === 'enabled')}><option value="enabled">Ativo</option><option value="blocked">Bloqueado</option></select></label>
        </div>
        <div className="inline-actions">
          <button className="button" type="submit">{saving ? 'Salvando…' : 'Revisar e salvar'}</button>
          <button className="button button-secondary" type="button" onClick={() => { setEditing(null); setCreating(false); }}>Cancelar</button>
        </div>
      </fieldset>
    </form>}
    {loading ? <p role="status">Carregando usuários…</p> : <>
      <div className="table-scroll"><table>
        <thead><tr><th>Usuário</th><th>Nome</th><th>Perfil</th><th>Status</th><th>Atualizado em</th>{canManage && <th>Ação</th>}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td>{row.username}</td><td>{row.display_name}</td><td>{roles[row.role_key]}</td>
          <td><span className="badge">{row.enabled ? 'Ativo' : 'Bloqueado'}</span></td>
          <td>{localDate(row.updated_at)}</td>{canManage && <td><button className="button button-secondary" disabled={saving} onClick={() => openEditor(row)}>Editar</button></td>}
        </tr>)}{rows.length === 0 && <tr><td colSpan={canManage ? 6 : 5}>Nenhum usuário encontrado.</td></tr>}</tbody>
      </table></div>
      <Pagination page={page} count={count} busy={saving} onPage={setPage} />
    </>}
  </div>;
}

function Collectors({ canManage }: { canManage: boolean }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [logins, setLogins] = useState<ProfileRow[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [userId, setUserId] = useState('');
  const [agentId, setAgentId] = useState('');

  useEffect(() => {
    let active = true;
    const client = supabase;
    setLoading(true);
    setLoadFailed(false);
    setError('');
    async function load() {
      try {
        if (!client) throw new Error('missing_client');
        const results = await Promise.all([
          client.from('collection_agents').select('id,display_name,enabled,updated_at', { count: 'exact' }).order('display_name').limit(500),
          client.from('profiles').select('id,username,display_name,role_key,enabled,updated_at', { count: 'exact' }).in('role_key', ['cobradora_1', 'cobradora_2']).order('username').limit(500),
          client.from('collector_bindings').select('user_id,agent_id', { count: 'exact' }).limit(500),
        ]);
        for (const result of results) {
          if (result.error) throw result.error;
          if ((result.count ?? 0) > 500) throw new Error('too_many_records');
        }
        if (active) {
          setAgents((results[0].data ?? []) as Agent[]);
          setLogins((results[1].data ?? []) as ProfileRow[]);
          setBindings((results[2].data ?? []) as Binding[]);
        }
      } catch (failure) {
        if (active) {
          setAgents([]); setLogins([]); setBindings([]);
          setLoadFailed(true);
          setError(friendlyError(failure, 'Não foi possível carregar o cadastro completo de cobradoras. Atualize e tente novamente.'));
        }
      } finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [revision]);

  async function saveAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || saving) return;
    setError(''); setSuccess('');
    if (!name.trim() || name.trim().length > 150) { setError('Informe o nome da pessoa responsável, com até 150 caracteres.'); return; }
    if (!window.confirm(`Confirmar ${editing ? 'alteração' : 'cadastro'} da cobradora ${name.trim()}?\nStatus: ${enabled ? 'Ativa' : 'Inativa'}\n\nUma cobradora inativa não acessará a carteira vinculada.`)) return;
    setSaving(true);
    try {
      const client = supabase;
      if (!client) throw new Error('missing_client');
      const result = await client.rpc('configure_collection_agent', {
        p_agent_id: editing?.id ?? null, p_display_name: name.trim(), p_enabled: enabled,
      });
      if (result.error) throw result.error;
      setEditing(null); setName(''); setEnabled(true);
      setSuccess('Cobradora salva com registro na auditoria.');
      setRevision(value => value + 1);
    } catch (failure) { setError(friendlyError(failure, 'Não foi possível salvar a cobradora. Tente novamente.')); }
    finally { setSaving(false); }
  }

  async function saveBinding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || saving) return;
    setError(''); setSuccess('');
    const login = logins.find(row => row.id === userId);
    const agent = agents.find(row => row.id === agentId);
    if (!login || (agentId && (!agent || !agent.enabled))) { setError('Selecione um login e uma cobradora ativa.'); return; }
    if (!window.confirm(`Confirmar vínculo de carteira?\n\nLogin: ${login.username}\nCobradora: ${agent?.display_name ?? 'SEM VÍNCULO'}\n\n${agent ? 'Esse login terá acesso somente à carteira dessa pessoa.' : 'Esse login ficará sem acesso a carteira de cobrança.'}`)) return;
    setSaving(true);
    try {
      const client = supabase;
      if (!client) throw new Error('missing_client');
      const result = await client.rpc('bind_collector', { p_user_id: userId, p_agent_id: agentId || null });
      if (result.error) throw result.error;
      setSuccess('Vínculo salvo e registrado na auditoria. Nenhum título foi redistribuído.');
      setUserId(''); setAgentId('');
      setRevision(value => value + 1);
    } catch (failure) { setError(friendlyError(failure, 'Não foi possível salvar o vínculo. Confira se a cobradora está disponível.')); }
    finally { setSaving(false); }
  }

  function openEditor(agent: Agent) {
    if (!canManage || saving) return;
    setEditing(agent); setName(agent.display_name); setEnabled(agent.enabled); setError(''); setSuccess('');
  }

  return <div className="stack">
    <div className="panel-heading"><div><h2>Cobradoras e carteiras</h2><p className="muted">A Gerência define quem utiliza cada login. Nenhuma associação é presumida.</p></div><button className="button button-secondary" disabled={saving || loading} onClick={() => setRevision(value => value + 1)}>Atualizar</button></div>
    <Feedback error={error} success={success} />
    {loading ? <p role="status">Carregando cobradoras e vínculos…</p> : <>
      <div className="table-scroll"><table>
        <thead><tr><th>Pessoa responsável</th><th>Status</th><th>Login vinculado</th>{canManage && <th>Ação</th>}</tr></thead>
        <tbody>{agents.map(agent => {
          const binding = bindings.find(row => row.agent_id === agent.id);
          const login = logins.find(row => row.id === binding?.user_id);
          return <tr key={agent.id}><td>{agent.display_name}</td><td>{agent.enabled ? 'Ativa' : 'Inativa'}</td><td>{login?.username ?? 'Sem vínculo'}</td>{canManage && <td><button className="button button-secondary" disabled={saving} onClick={() => openEditor(agent)}>Editar</button></td>}</tr>;
        })}{agents.length === 0 && <tr><td colSpan={canManage ? 4 : 3}>Nenhuma cobradora cadastrada.</td></tr>}</tbody>
      </table></div>
      {canManage && <form className="panel stack" onSubmit={event => { void saveAgent(event); }}>
        <h3>{editing ? 'Editar cobradora' : 'Cadastrar pessoa responsável'}</h3>
        <fieldset disabled={saving || loadFailed}>
          <div className="field-grid">
            <label className="field">Nome da cobradora<input required value={name} onChange={event => setName(event.target.value)} maxLength={150} /></label>
            <label className="field">Status<select value={enabled ? 'active' : 'inactive'} onChange={event => setEnabled(event.target.value === 'active')}><option value="active">Ativa</option><option value="inactive">Inativa</option></select></label>
          </div>
          <div className="inline-actions"><button className="button" type="submit">{saving ? 'Salvando…' : 'Revisar e salvar cobradora'}</button>{editing && <button className="button button-secondary" type="button" onClick={() => { setEditing(null); setName(''); setEnabled(true); }}>Cancelar edição</button>}</div>
        </fieldset>
      </form>}
      {canManage && <form className="panel stack" onSubmit={event => { void saveBinding(event); }}>
        <h3>Vincular login à pessoa responsável</h3>
        <p className="muted">Sem vínculo, o acesso de cobradora permanece sem carteira. Alterar o vínculo não redistribui títulos.</p>
        <fieldset disabled={saving || logins.length === 0}>
          <div className="field-grid">
            <label className="field">Login<select required value={userId} onChange={event => { setUserId(event.target.value); setAgentId(bindings.find(row => row.user_id === event.target.value)?.agent_id ?? ''); }}><option value="">Selecione o login</option>{logins.map(login => <option key={login.id} value={login.id}>{login.username}{login.enabled ? '' : ' (bloqueado)'}</option>)}</select></label>
            <label className="field">Pessoa responsável<select value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">Sem vínculo</option>{agents.map(agent => {
              const occupied = bindings.some(row => row.agent_id === agent.id && row.user_id !== userId);
              return <option key={agent.id} value={agent.id} disabled={!agent.enabled || occupied}>{agent.display_name}{!agent.enabled ? ' (inativa)' : occupied ? ' (já vinculada)' : ''}</option>;
            })}</select></label>
          </div>
          <button className="button" type="submit">{saving ? 'Salvando…' : 'Revisar e salvar vínculo'}</button>
        </fieldset>
        {logins.length === 0 && <p className="muted">Cadastre primeiro os perfis de acesso das cobradoras na aba Usuários.</p>}
      </form>}
    </>}
  </div>;
}

function AuditLog() {
  const [rows, setRows] = useState<AuditEvent[]>([]);
  const [page, setPage] = useState(0);
  const [count, setCount] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const client = supabase;
    setLoading(true); setError('');
    async function load() {
      try {
        if (!client) throw new Error('missing_client');
        const result = await client.from('audit_events')
          .select('id,occurred_at,username,role_key,module,entity,record_id,action', { count: 'exact' })
          .order('occurred_at', { ascending: false }).order('id', { ascending: false })
          .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        if (result.error) throw result.error;
        if (active) { setRows((result.data ?? []) as AuditEvent[]); setCount(result.count ?? 0); }
      } catch (failure) {
        if (active) { setRows([]); setError(friendlyError(failure, 'Não foi possível carregar a auditoria. Tente novamente.')); }
      } finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [page, revision]);

  return <div className="stack">
    <div className="panel-heading"><div><h2>Auditoria central</h2><p className="muted">Histórico imutável das operações registradas. Horários de Brasília.</p></div><button className="button button-secondary" disabled={loading} onClick={() => setRevision(value => value + 1)}>Atualizar</button></div>
    <Feedback error={error} success="" />
    {loading ? <p role="status">Carregando auditoria…</p> : <>
      <div className="table-scroll"><table>
        <thead><tr><th>Data/hora</th><th>Usuário</th><th>Perfil</th><th>Módulo</th><th>Entidade</th><th>Ação</th><th>Registro</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}><td>{localDate(row.occurred_at)}</td><td>{row.username ?? 'Operação administrativa'}</td><td>{row.role_key && row.role_key in roles ? roles[row.role_key as Role] : '—'}</td><td>{row.module}</td><td>{row.entity}</td><td><span className="badge">{row.action}</span></td><td><code>{row.record_id ?? '—'}</code></td></tr>)}{rows.length === 0 && <tr><td colSpan={7}>Nenhum evento de auditoria disponível.</td></tr>}</tbody>
      </table></div>
      <Pagination page={page} count={count} busy={loading} onPage={setPage} />
    </>}
  </div>;
}

export default function Administration({ onAccessChanged, canManage = false }: { onAccessChanged: () => Promise<void>; canManage?: boolean }) {
  const [tab, setTab] = useState<'users' | 'collectors' | 'audit'>('users');
  return <section className="panel stack" aria-label="Administração da Central Financeira">
    {!canManage && <p className="notice" role="status">Acesso somente para consulta. Usuários, cobradoras e auditoria estão disponíveis para leitura.</p>}
    <div className="inline-actions" role="group" aria-label="Áreas administrativas">
      <button className={`button${tab === 'users' ? '' : ' button-secondary'}`} aria-pressed={tab === 'users'} onClick={() => setTab('users')}>Usuários</button>
      <button className={`button${tab === 'collectors' ? '' : ' button-secondary'}`} aria-pressed={tab === 'collectors'} onClick={() => setTab('collectors')}>Cobradoras</button>
      <button className={`button${tab === 'audit' ? '' : ' button-secondary'}`} aria-pressed={tab === 'audit'} onClick={() => setTab('audit')}>Auditoria</button>
    </div>
    {tab === 'users' && <Users onAccessChanged={onAccessChanged} canManage={canManage} />}
    {tab === 'collectors' && <Collectors canManage={canManage} />}
    {tab === 'audit' && <AuditLog />}
  </section>;
}
