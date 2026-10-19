import { useEffect, useMemo, useRef, useState } from 'react';
import { dateLabel, formatCents } from '../lib/payables';
import { collectionEmailLinks, collectionEmailMessage, downloadCollectionEmail, readCollectionEmailDraft, type CollectionEmailDraft as OfficialEmailDraft } from '../lib/collection-email';
import '../collection-email-draft.css';

interface Completion { requestId: string; titleId: string }
interface Props { completion: Completion; onDismiss: () => void; refreshKey?: number }
const emptyLinks = { gmail: null, outlook: null, mailto: null };

function requestMessage(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(code)) return 'Ative a atualização de rascunhos de cobrança no banco.';
  if (code === '54000') return 'Este cliente possui mais de 5.000 títulos pendentes nesta carteira. O rascunho não foi preparado para evitar uma lista incompleta.';
  if (code === '22003') return 'O total dos títulos excede o limite seguro de precisão. Confira a base com o financeiro antes de preparar o rascunho.';
  if (code === '22023') return 'Confira os e-mails salvos nos contatos deste cliente antes de preparar o rascunho.';
  if (code === '42501') return 'Seu acesso não permite preparar este rascunho. Confira a carteira e as permissões com a administração.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente para consultar os títulos e contatos.';
  return 'Não foi possível consultar os títulos e contatos atuais. Tente preparar o rascunho novamente.';
}

export default function CollectionEmailDraft({ completion, onDismiss, refreshKey = 0 }: Props) {
  const [draft, setDraft] = useState<OfficialEmailDraft | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [draftRefreshKey, setDraftRefreshKey] = useState(refreshKey);
  const [busy, setBusy] = useState(false), [copying, setCopying] = useState(false), [error, setError] = useState(''), [feedback, setFeedback] = useState('');
  const controller = useRef<AbortController | null>(null), generation = useRef(0), prepared = useRef(false), queryPending = useRef(false);
  const previousRefreshKey = useRef(refreshKey), currentRefreshKey = useRef(refreshKey);
  const completionRef = useRef(completion), preview = useRef<HTMLDivElement | null>(null);
  completionRef.current = completion; currentRefreshKey.current = refreshKey;
  const fresh = draftRefreshKey === refreshKey;

  useEffect(() => {
    generation.current++; controller.current?.abort(); prepared.current = false; queryPending.current = false; previousRefreshKey.current = refreshKey;
    setDraft(null); setSelected([]); setBusy(false); setCopying(false); setError(''); setFeedback('');
    return () => { generation.current++; controller.current?.abort(); };
  }, [completion.requestId, completion.titleId]);
  useEffect(() => {
    const changed = previousRefreshKey.current !== refreshKey; previousRefreshKey.current = refreshKey;
    if (!changed || !prepared.current && !queryPending.current) return;
    generation.current++; controller.current?.abort(); queryPending.current = false;
    setDraft(null); setBusy(false); setCopying(false); setError('');
    setFeedback('Dados de títulos ou contatos alterados. Prepare o rascunho novamente antes de abrir o e-mail.');
  }, [refreshKey]);
  useEffect(() => { if (draft && draft.total_count > 0) preview.current?.focus({ preventScroll: true }); }, [draft]);

  async function prepare() {
    if (busy) return;
    const current = ++generation.current, target = { ...completion }, requestedRefreshKey = refreshKey;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const previouslyPrepared = prepared.current;
    queryPending.current = true;
    setBusy(true); setDraft(null); setError(''); setFeedback('');
    try {
      const next = await readCollectionEmailDraft(target, abort.signal);
      if (abort.signal.aborted || current !== generation.current || currentRefreshKey.current !== requestedRefreshKey || completionRef.current.requestId !== target.requestId || completionRef.current.titleId !== target.titleId) return;
      setSelected(previous => previouslyPrepared ? previous.filter(address => next.emails.includes(address)) : [...next.emails]);
      prepared.current = true; setDraftRefreshKey(requestedRefreshKey); setDraft(next);
    } catch (failure) {
      if (!abort.signal.aborted && current === generation.current && currentRefreshKey.current === requestedRefreshKey) setError(requestMessage(failure));
    } finally { if (!abort.signal.aborted && current === generation.current && currentRefreshKey.current === requestedRefreshKey) { queryPending.current = false; setBusy(false); } }
  }

  const message = useMemo(() => draft && draft.total_count > 0 ? collectionEmailMessage(draft) : null, [draft]);
  const recipients = useMemo(() => selected.filter(address => draft?.emails.includes(address)), [selected, draft]);
  const links = useMemo(() => recipients.length && message ? collectionEmailLinks(recipients, message.subject, message.body) : emptyLinks, [recipients, message]);
  const hasLongLink = recipients.length > 0 && message !== null && (!links.gmail || !links.outlook || !links.mailto);

  async function copyMessage() {
    if (!message || !fresh || busy || copying) return;
    const current = generation.current; setCopying(true); setFeedback('');
    try {
      await navigator.clipboard.writeText(`${message.subject}\n\n${message.body}`);
      if (current === generation.current) setFeedback('Assunto e mensagem copiados. Cole no seu aplicativo de e-mail.');
    } catch {
      if (current === generation.current) setFeedback('Não foi possível copiar automaticamente. Selecione o assunto e a mensagem abaixo ou baixe a mensagem em texto.');
    } finally { if (current === generation.current) setCopying(false); }
  }
  function downloadDraft() {
    if (!message || !fresh || !recipients.length || busy) return;
    setFeedback('');
    try { downloadCollectionEmail(recipients, message.subject, message.body); setFeedback('Rascunho preparado para baixar. Abra o arquivo no seu aplicativo de e-mail para revisar.'); }
    catch { setFeedback('Não foi possível preparar o arquivo do rascunho. Copie a mensagem e tente novamente.'); }
  }
  function downloadText() {
    if (!message || !fresh || busy) return;
    let url: string | null = null;
    try {
      const blob = new Blob([`${message.subject}\r\n\r\n${message.body}`], { type: 'text/plain;charset=utf-8' });
      url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'mensagem-de-cobranca.txt'; link.click();
      const downloadUrl = url; window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000); url = null;
      setFeedback('Mensagem em texto preparada para baixar.');
    } catch { setFeedback('Não foi possível baixar a mensagem. Selecione e copie o texto abaixo.'); }
    finally { if (url) URL.revokeObjectURL(url); }
  }
  function emailLink(label: string, href: string | null) {
    return href && fresh && !busy ? <a className="button secondary" href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <button type="button" className="button secondary" disabled>{label}</button>;
  }

  return <section className="panel collection-email-draft" aria-label="Rascunho de e-mail de cobrança" aria-busy={busy}>
    <div className="panel-header"><div><h2>E-mail após o atendimento</h2><p className="muted">Prepare uma mensagem com os títulos pendentes do mesmo cliente, separando vencidos e a vencer.</p></div><button type="button" className="button secondary" disabled={busy || copying} onClick={onDismiss}>Fechar rascunho</button></div>
    <div className="inline-actions"><button type="button" className="button" disabled={busy || copying} onClick={() => void prepare()}>{busy ? 'Consultando títulos e contatos…' : draft && fresh ? 'Atualizar títulos e contatos' : 'Preparar e-mail de cobrança'}</button></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {busy && <p className="help-text" role="status">Consultando os títulos pendentes e os contatos salvos na base central…</p>}
    {draft && fresh && draft.total_count === 0 && <p className="notice" role="status">Não há títulos pendentes para este cliente nesta carteira.</p>}
    {draft && fresh && message && <div ref={preview} tabIndex={-1} className="collection-email-preview" role="region" aria-label="Prévia da mensagem de cobrança">
      <div className="collection-email-client"><h3>{draft.client_name}</h3><p>Posição de {dateLabel(draft.as_of_date)} · {draft.total_count.toLocaleString('pt-BR')} título(s) pendente(s)</p></div>
      <dl className="collection-email-totals"><div><dt>Vencidos</dt><dd>{formatCents(draft.overdue_cents)}</dd><small>{draft.overdue_count.toLocaleString('pt-BR')} título(s)</small></div><div><dt>A vencer</dt><dd>{formatCents(draft.upcoming_cents)}</dd><small>{draft.upcoming_count.toLocaleString('pt-BR')} título(s)</small></div><div><dt>Total pendente</dt><dd>{formatCents(draft.total_cents)}</dd><small>{draft.total_count.toLocaleString('pt-BR')} título(s)</small></div></dl>
      {draft.emails.length > 0 ? <fieldset className="collection-email-recipients" disabled={busy}><legend>Destinatários dos contatos salvos</legend>{draft.emails.map(address => <label className="checkbox-field" key={address}><input type="checkbox" checked={recipients.includes(address)} onChange={event => { setSelected(previous => event.target.checked ? [...new Set([...previous, address])] : previous.filter(item => item !== address)); setFeedback(''); }} /><span>{address}</span></label>)}<p className="help-text">Selecione os endereços que receberão a mensagem. Para alterar o cadastro, salve os contatos do órgão e atualize este rascunho.</p></fieldset> : <p className="notice">Nenhum e-mail está cadastrado para este cliente. Cadastre o e-mail nos contatos do órgão e clique em Atualizar títulos e contatos. Você pode copiar ou baixar a mensagem em texto enquanto isso.</p>}
      {draft.emails.length > 0 && !recipients.length && <p className="help-text">Selecione ao menos um destinatário para abrir o rascunho no aplicativo de e-mail.</p>}
      <label className="field">Assunto do e-mail<input readOnly value={message.subject} /></label>
      <label className="field">Mensagem de cobrança<textarea readOnly value={message.body} rows={16} spellCheck={false} /></label>
      <div className="collection-email-actions">{emailLink('Abrir no Gmail', links.gmail)}{emailLink('Abrir no Outlook', links.outlook)}{emailLink('Abrir no aplicativo de e-mail', links.mailto)}</div>
      {hasLongLink && <p className="notice">A mensagem completa excede o limite de abertura por link em algum aplicativo. Copie a mensagem ou baixe o rascunho para abrir no seu e-mail. O texto permanece completo.</p>}
      <div className="collection-email-actions"><button type="button" className="button secondary" disabled={busy || copying} onClick={() => void copyMessage()}>{copying ? 'Copiando mensagem…' : 'Copiar mensagem'}</button><button type="button" className="button secondary" disabled={busy || !recipients.length} onClick={downloadDraft}>Baixar rascunho (.eml)</button><button type="button" className="button secondary" disabled={busy} onClick={downloadText}>Baixar mensagem (.txt)</button></div>
      <p className="help-text">Revise a mensagem e confirme o envio no aplicativo escolhido.</p>
    </div>}
    {feedback && <p className="notice" role="status">{feedback}</p>}
  </section>;
}
