import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

type Priority = 'normal' | 'atencao' | 'urgente'
type MessageStatus = 'pendente' | 'concluida'
type StatusFilter = MessageStatus | 'todos'

interface ManagementMessage {
  id: string
  author_name: string
  author_role: 'diretor' | 'gerente_geral'
  priority: Priority
  reference: string | null
  message: string
  status: MessageStatus
  created_at: string
  completed_at: string | null
  reopened_at: string | null
}

const PAGE_SIZE = 25
const priorityLabels: Record<Priority, string> = {
  normal: 'Normal',
  atencao: 'Atenção',
  urgente: 'Urgente',
}
const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'short',
})

function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date)
}

function friendlyError(error: unknown, fallback: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : ''
  if (code === '42501') return 'Seu perfil não tem permissão para realizar esta operação.'
  if (code === 'PGRST301' || code === 'PGRST303') {
    return 'Sua sessão expirou. Entre novamente para continuar.'
  }
  if (code === 'P0002') return 'A mensagem não foi encontrada. Atualize a lista e tente novamente.'
  if (code === '23514') return 'Confira a prioridade, a referência e o conteúdo da mensagem.'
  return fallback
}

export default function ManagementMessages({ canWrite }: { canWrite: boolean }) {
  const [messages, setMessages] = useState<ManagementMessage[]>([])
  const [filter, setFilter] = useState<StatusFilter>('todos')
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [priority, setPriority] = useState<Priority>('normal')
  const [reference, setReference] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const client = supabase
    if (!client) {
      setLoading(false)
      return
    }
    let cancelled = false
    const controller = new AbortController()

    async function loadMessages() {
      setLoading(true)
      setError('')
      setMessages([])
      try {
        let query = client!.from('management_messages')
          .select('id,author_name,author_role,priority,reference,message,status,created_at,completed_at,reopened_at', { count: 'exact' })
          .order('status', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
        if (filter !== 'todos') query = query.eq('status', filter)
        const result = await query.abortSignal(controller.signal)
        if (cancelled) return
        if (result.error) throw result.error
        const count = result.count ?? 0
        const lastPage = Math.max(0, Math.ceil(count / PAGE_SIZE) - 1)
        setTotal(count)
        if (page > lastPage) {
          setPage(lastPage)
          return
        }
        setMessages((result.data ?? []) as ManagementMessage[])
        setUpdatedAt(new Date().toISOString())
      } catch (loadError) {
        if (!cancelled) {
          setError(friendlyError(loadError, 'Não foi possível carregar as mensagens. Tente atualizar a lista.'))
          setTotal(0)
          setUpdatedAt(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadMessages()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [filter, page, refresh])

  async function createMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !canWrite || saving) return
    setError('')
    setSuccess('')
    const cleanMessage = message.trim()
    const cleanReference = reference.trim()
    if (cleanMessage.length < 1 || cleanMessage.length > 5000) {
      setError('Escreva uma mensagem de até 5.000 caracteres.')
      return
    }
    if (cleanReference.length > 300 || !Object.hasOwn(priorityLabels, priority)) {
      setError('Selecione uma prioridade válida e use até 300 caracteres na referência.')
      return
    }
    if (!window.confirm('Confirma o envio desta mensagem para o quadro da Diretoria e Gerência?')) return
    setSaving('create')
    try {
      const { error: writeError } = await supabase.rpc('create_management_message', {
        p_priority: priority,
        p_reference: cleanReference || null,
        p_message: cleanMessage,
      })
      if (writeError) throw writeError
      setMessage('')
      setReference('')
      setPriority('normal')
      setFilter('pendente')
      setPage(0)
      setSuccess('Mensagem registrada com sucesso.')
      setRefresh((value) => value + 1)
    } catch (writeError) {
      setError(friendlyError(writeError, 'Não foi possível confirmar o envio. Atualize a lista antes de tentar novamente.'))
    } finally {
      setSaving(null)
    }
  }

  async function changeStatus(item: ManagementMessage) {
    if (!supabase || !canWrite || saving) return
    const nextStatus: MessageStatus = item.status === 'pendente' ? 'concluida' : 'pendente'
    const question = nextStatus === 'concluida'
      ? 'Confirma a conclusão desta mensagem? O histórico será preservado.'
      : 'Confirma a reabertura desta mensagem? Ela voltará para as pendências.'
    if (!window.confirm(question)) return
    setError('')
    setSuccess('')
    setSaving(item.id)
    try {
      const { error: writeError } = await supabase.rpc('set_management_message_status', {
        p_message_id: item.id,
        p_status: nextStatus,
      })
      if (writeError) throw writeError
      setSuccess(nextStatus === 'concluida' ? 'Mensagem concluída.' : 'Mensagem reaberta.')
      setRefresh((value) => value + 1)
    } catch (writeError) {
      setError(friendlyError(writeError, 'Não foi possível confirmar a alteração. Atualize a lista antes de tentar novamente.'))
    } finally {
      setSaving(null)
    }
  }

  if (!supabase) {
    return <div className="notice">Configure a conexão com o Supabase para acessar as mensagens.</div>
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <section className="panel messages-panel" aria-labelledby="messages-title">
      <div className="panel-header">
        <div>
          <h2 id="messages-title">Mensagens da Diretoria e Gerência</h2>
          <p>Orientações e pendências de Contas a Pagar, com histórico de conclusão e reabertura.</p>
        </div>
        <button className="button secondary" type="button" disabled={loading || saving !== null} onClick={() => setRefresh((value) => value + 1)}>
          {loading ? 'Atualizando…' : 'Atualizar mensagens'}
        </button>
      </div>

      {error && <p className="notice error" role="alert">{error}</p>}
      {success && <p className="notice success" role="status">{success}</p>}

      {canWrite && (
        <form className="messages-form" onSubmit={(event) => void createMessage(event)}>
          <fieldset disabled={saving !== null}>
            <legend>Nova mensagem</legend>
            <div className="form-grid">
              <label className="field" htmlFor="message-priority">
                Prioridade
                <select id="message-priority" value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
                  <option value="normal">Normal</option>
                  <option value="atencao">Atenção</option>
                  <option value="urgente">Urgente</option>
                </select>
              </label>
              <label className="field" htmlFor="message-reference">
                Lançamento / referência (opcional)
                <input id="message-reference" type="text" maxLength={300} value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Ex.: lançamento ou fornecedor" />
              </label>
            </div>
            <label className="field" htmlFor="message-content">
              Mensagem
              <textarea id="message-content" required maxLength={5000} rows={4} value={message} onChange={(event) => setMessage(event.target.value)} aria-describedby="message-content-help" />
            </label>
            <div className="toolbar">
              <small id="message-content-help">{message.length.toLocaleString('pt-BR')} / 5.000 caracteres. Autor e perfil são registrados automaticamente.</small>
              <button className="button primary" type="submit" disabled={saving !== null || !message.trim()}>
                {saving === 'create' ? 'Enviando…' : 'Enviar mensagem'}
              </button>
            </div>
          </fieldset>
        </form>
      )}

      <div className="toolbar">
        <label className="field" htmlFor="messages-status-filter">
          Status
          <select id="messages-status-filter" value={filter} disabled={saving !== null} onChange={(event) => { setFilter(event.target.value as StatusFilter); setPage(0) }}>
            <option value="todos">Todos — pendentes primeiro</option>
            <option value="pendente">Pendentes</option>
            <option value="concluida">Concluídas</option>
          </select>
        </label>
        {updatedAt && <small>Atualizado em {formatDate(updatedAt)} · horário de Brasília</small>}
      </div>

      <div className="table-wrap" aria-busy={loading}>
        <table className="data-table messages-table">
          <caption className="sr-only">Mensagens, com até 25 registros por página.</caption>
          <thead>
            <tr>
              <th scope="col">Autor / data</th>
              <th scope="col">Prioridade</th>
              <th scope="col">Mensagem</th>
              <th scope="col">Status / histórico</th>
              {canWrite && <th scope="col">Ação</th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={canWrite ? 5 : 4} className="empty-state">Carregando mensagens…</td></tr>
            ) : messages.length === 0 ? (
              <tr><td colSpan={canWrite ? 5 : 4} className="empty-state">{error ? 'A lista está indisponível. Tente atualizar.' : 'Nenhuma mensagem para este filtro.'}</td></tr>
            ) : messages.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.author_name}</strong>
                  <div>{item.author_role === 'diretor' ? 'Diretoria' : 'Gerência'}</div>
                  <small>{formatDate(item.created_at)}</small>
                </td>
                <td><span className={`badge ${item.priority}`}>{priorityLabels[item.priority]}</span></td>
                <td>
                  {item.reference && <div className="message-reference"><strong>Referência:</strong> {item.reference}</div>}
                  <div className="message-content" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.message}</div>
                </td>
                <td>
                  <span className={`badge ${item.status}`}>{item.status === 'pendente' ? 'Pendente' : 'Concluída'}</span>
                  {item.completed_at && <div><small>Concluída: {formatDate(item.completed_at)}</small></div>}
                  {item.reopened_at && <div><small>Reaberta: {formatDate(item.reopened_at)}</small></div>}
                </td>
                {canWrite && (
                  <td>
                    <button className="button secondary" type="button" disabled={saving !== null} onClick={() => void changeStatus(item)} aria-label={`${item.status === 'pendente' ? 'Concluir' : 'Reabrir'} mensagem de ${item.author_name}`}>
                      {saving === item.id ? 'Salvando…' : item.status === 'pendente' ? 'Concluir' : 'Reabrir'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pagination" aria-label="Paginação das mensagens">
        <span>{total.toLocaleString('pt-BR')} {total === 1 ? 'mensagem' : 'mensagens'} · página {page + 1} de {pageCount}</span>
        <div>
          <button className="button secondary" type="button" disabled={loading || saving !== null || page === 0} onClick={() => setPage((value) => value - 1)}>Anterior</button>
          <button className="button secondary" type="button" disabled={loading || saving !== null || page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>Próxima</button>
        </div>
      </div>
    </section>
  )
}
