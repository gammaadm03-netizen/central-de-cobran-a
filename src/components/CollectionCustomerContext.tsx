import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { collectionDateTime } from '../lib/collection-workbench';
import '../collection-customer-context.css';

interface Contact { emails: string[]; phones: string[]; notes: string | null; revision: string; record_revision: number; manually_edited: boolean; reviewed_at: string | null; reviewed_by: string | null; reviewed_by_name: string | null; updated_at: string | null; updated_by: string | null; updated_by_name: string | null }
interface Description { id: string; description: string; contract: string | null; source_import_id: string; imported_at: string }
interface Context { title_id: string; customer_key: string; client_name: string; client_document: string | null; can_edit: boolean; can_review: boolean; contact: Contact; descriptions: { state: 'MISSING' | 'AVAILABLE' | 'PENDING_VARIANTS'; count: number; variants: Description[] }; as_of_date: string; server_now: string }
interface Draft { emails: string; phones: string; notes: string }
interface Frozen { p_title_id: string; p_emails: string[]; p_phones: string[]; p_notes: string; p_expected_revision: string; p_request_id: string }
export interface CollectionContactGuard { dirty: boolean; pending: boolean }
export interface CollectionCustomerContextProps { titleId: string; customerKey: string; canEdit: boolean; enabled?: boolean; refreshKey?: number; discardKey?: number; onChange?: () => void; onGuardChange?: (guard: CollectionContactGuard) => void }
const blank: Draft = { emails: '', phones: '', notes: '' };
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const control = /[\u0000-\u001f\u007f]/;
const lines = (value: string) => value.split(/\r?\n/).map(part => part.trim()).filter(Boolean);
const draftOf = (contact: Contact): Draft => ({ emails: contact.emails.join('\n'), phones: contact.phones.join('\n'), notes: contact.notes ?? '' });
const key = (draft: Draft) => JSON.stringify(draft);
function safeEmail(value: string) { return value.length <= 320 && email.test(value) && !control.test(value); }
function phoneHref(value: string) { const digits = value.replace(/\D/g, ''); return /^\+?[\d\s().-]+$/.test(value) && digits.length >= 8 && digits.length <= 15 ? `tel:${value.trim().startsWith('+') ? '+' : ''}${digits}` : null; }
function validContext(value: Context, titleId: string, customerKey: string) {
  const contact = value?.contact, descriptions = value?.descriptions;
  return !!value && value.title_id === titleId && value.customer_key === customerKey && typeof value.client_name === 'string' && typeof value.can_edit === 'boolean' && typeof value.can_review === 'boolean'
    && !!contact && typeof contact.revision === 'string' && contact.revision.length > 0 && contact.revision.length <= 256 && Number.isSafeInteger(contact.record_revision) && contact.record_revision >= 0
    && typeof contact.manually_edited === 'boolean' && Array.isArray(contact.emails) && contact.emails.length <= 50 && contact.emails.every(item => typeof item === 'string' && item.length <= 320 && !control.test(item))
    && Array.isArray(contact.phones) && contact.phones.length <= 50 && contact.phones.every(item => typeof item === 'string' && item.length <= 80 && !control.test(item)) && (contact.notes === null || typeof contact.notes === 'string')
    && [contact.reviewed_at, contact.updated_at].every(item => item === null || typeof item === 'string' && Number.isFinite(Date.parse(item)))
    && !!descriptions && ['MISSING', 'AVAILABLE', 'PENDING_VARIANTS'].includes(descriptions.state) && Number.isSafeInteger(descriptions.count) && descriptions.count >= 0 && Array.isArray(descriptions.variants)
    && descriptions.variants.every(item => typeof item.id === 'string' && typeof item.description === 'string' && (item.contract === null || typeof item.contract === 'string') && Number.isFinite(Date.parse(item.imported_at)));
}
function errorText(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['PGRST202', 'PGRST205', '42P01'].includes(code)) return 'Contatos e descrições aguardam a atualização do banco. O atendimento do título continua disponível.';
  if (code === '42501') return 'Este contexto está disponível somente para títulos ativos e vencidos da carteira autorizada. Atualize a carteira.';
  if (code === '40001') return 'Os contatos mudaram em outra operação. Seu rascunho foi preservado; confira a versão atual antes de salvar.';
  if (code === '22023' || code === '23514') return 'Confira os e-mails, telefones e observações. Nenhuma alteração deste envio foi confirmada.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  return 'Não foi possível confirmar a operação. O envio e seu protocolo foram preservados para repetir a confirmação.';
}

export default function CollectionCustomerContext({ titleId, customerKey, canEdit, enabled = true, refreshKey = 0, discardKey = 0, onChange, onGuardChange }: CollectionCustomerContextProps) {
  const [context, setContext] = useState<Context | null>(null), [draft, setDraft] = useState<Draft>(blank), [baseline, setBaseline] = useState<Draft>(blank);
  const [expanded, setExpanded] = useState(false), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false), [conflictLoaded, setConflictLoaded] = useState(false), [pending, setPending] = useState<Frozen | null>(null), [forbidden, setForbidden] = useState(false), [reload, setReload] = useState(0);
  const mounted = useRef(true), contextRef = useRef(context), draftRef = useRef(draft), baselineRef = useRef(baseline), pendingRef = useRef(pending);
  contextRef.current = context; draftRef.current = draft; baselineRef.current = baseline; pendingRef.current = pending;
  const dirty = key(draft) !== key(baseline), editable = canEdit && context?.can_edit && context.can_review && enabled && !forbidden;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onGuardChange?.({ dirty, pending: busy || !!pending }); }, [dirty, busy, pending, onGuardChange]);
  useEffect(() => () => onGuardChange?.({ dirty: false, pending: false }), [onGuardChange]);
  useEffect(() => {
    if (!dirty && !pending && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, pending, busy]);
  useEffect(() => {
    if (pendingRef.current) return;
    const current = contextRef.current; if (!current) return;
    const next = draftOf(current.contact); setDraft(next); setBaseline(next); setConflict(false); setError(''); setNotice('');
  }, [discardKey]);
  useEffect(() => {
    if (!enabled || !supabase || pendingRef.current) return;
    const abort = new AbortController(); setLoading(true); setError(''); setForbidden(false);
    void Promise.resolve(supabase.rpc('collection_customer_context', { p_title_id: titleId }).abortSignal(abort.signal).retry(false)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error) throw result.error;
      const data = result.data as Context; if (!validContext(data, titleId, customerKey)) throw new Error('invalid_context');
      const wasDirty = key(draftRef.current) !== key(baselineRef.current), old = contextRef.current;
      setContext(data);
      if (wasDirty && old && old.contact.revision !== data.contact.revision) { setConflict(true); setConflictLoaded(true); }
      else if (conflict) setConflictLoaded(true);
      if (!wasDirty) { const next = draftOf(data.contact); setDraft(next); setBaseline(next); }
    }).catch(failure => { if (!abort.signal.aborted) { const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : ''; if (code === '42501') setForbidden(true); setError(errorText(failure)); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [titleId, customerKey, enabled, refreshKey, reload]);
  async function execute(request: Frozen) {
    if (!supabase || busy || (!enabled || forbidden) && request !== pendingRef.current) return;
    setPending(request); setBusy(true); setError(''); setNotice('');
    try {
      const result = await supabase.rpc('save_collection_customer_contacts', request).retry(false); if (result.error) throw result.error;
      const data = result.data as Context; if (!validContext(data, request.p_title_id, customerKey)) throw new Error('unknown_result');
      if (!mounted.current) return;
      setContext(data); const next = draftOf(data.contact); setDraft(next); setBaseline(next); setPending(null); setConflict(false); setNotice('Contatos salvos e revisão registrada na base central.'); onChange?.();
    } catch (failure) {
      if (!mounted.current) return;
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      const known = ['40001', '42501', '22023', '23514', 'PGRST301', 'PGRST303'].includes(code);
      if (known) setPending(null);
      if (code === '40001') { setConflict(true); setConflictLoaded(false); }
      if (code === '42501') setForbidden(true);
      setError(errorText(failure));
    } finally { if (mounted.current) setBusy(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault(); if (!context || !editable || busy || loading || pending || conflict) return;
    const emails = lines(draft.emails), phones = lines(draft.phones);
    if (emails.length > 50 || phones.length > 50 || emails.some(item => !safeEmail(item)) || phones.some(item => item.length > 80 || control.test(item) || item.replace(/\D/g, '').length < 3 || item.replace(/\D/g, '').length > 30) || draft.notes.length > 5000) { setError('Informe até 50 e-mails e 50 telefones, um por linha. Confira os formatos e limite as observações a 5.000 caracteres.'); return; }
    void execute({ p_title_id: titleId, p_emails: emails, p_phones: phones, p_notes: draft.notes, p_expected_revision: context.contact.revision, p_request_id: crypto.randomUUID() });
  }
  if (!enabled) return dirty || pending ? <div className="notice collection-context-recovery"><p>O contexto deste título ficou indisponível. O rascunho dos contatos foi preservado; os dados não são exibidos fora da carteira ativa vencida.</p>{pending && <button type="button" className="button secondary" disabled={busy} onClick={() => void execute(pending)}>Repetir confirmação dos contatos</button>}</div> : null;
  const contact = context?.contact, missing = !!contact && (!contact.emails.length || !contact.phones.length);
  return <details className="collection-customer-context" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>Contatos e descrição do órgão<small>{loading ? 'Consultando base central…' : forbidden ? 'Contexto indisponível para este título' : !contact ? 'Informações pendentes de consulta' : `${contact.emails.length} e-mail(s) · ${contact.phones.length} telefone(s) · ${contact.reviewed_at ? missing ? 'Revisado com pendências' : 'Revisado' : 'Revisão pendente'}`}</small></summary>
    <div className="collection-customer-context-body">{error && <p className="notice error" role="alert">{error}</p>}{notice && <p className="notice success" role="status">{notice}</p>}
      {!forbidden && context && <><p className="help-text">Contatos compartilhados entre os títulos deste órgão. Endereços informados não significam confirmação de entrega ou de funcionamento.</p>
        <div className="collection-context-links">{contact!.emails.map((item, index) => safeEmail(item) ? <a key={`email-${index}`} href={`mailto:${encodeURIComponent(item)}`}>{item}</a> : <span key={`email-${index}`}>{item}</span>)}{contact!.phones.map((item, index) => { const href = phoneHref(item); return href ? <a key={`phone-${index}`} href={href}>{item}</a> : <span key={`phone-${index}`}>{item}</span>; })}</div>
        {!contact!.emails.length && <p className="help-text">E-mail não informado.</p>}{!contact!.phones.length && <p className="help-text">Telefone não informado.</p>}
        <p className="collection-context-meta">Última manutenção: {contact!.updated_at ? collectionDateTime(contact!.updated_at) : 'Não registrada'}{contact!.updated_by_name ? ` · ${contact!.updated_by_name}` : ''}<br />Revisão: {contact!.reviewed_at ? collectionDateTime(contact!.reviewed_at) : 'Pendente'}{contact!.reviewed_by_name ? ` · ${contact!.reviewed_by_name}` : ''}</p>
        {pending && <div className="notice"><p>A confirmação deste contato está pendente. O mesmo envio e protocolo foram preservados.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void execute(pending)}>Repetir confirmação dos contatos</button></div>}
        {conflict && <div className="collection-context-conflict"><p>Seu rascunho foi preservado. Consulte os contatos atuais e escolha como continuar.</p><button type="button" className="button secondary" disabled={loading || busy || !!pending} onClick={() => setReload(value => value + 1)}>Conferir versão atual dos contatos</button>{conflictLoaded && <p>Versão atual consultada:<br />E-mails: {contact!.emails.join(' · ') || 'Não informados'}<br />Telefones: {contact!.phones.join(' · ') || 'Não informados'}<br />Observações: {contact!.notes || 'Não informadas'}</p>}<div className="collection-context-buttons"><button type="button" className="button secondary" disabled={loading || busy || !!pending || !conflictLoaded} onClick={() => { const next = draftOf(contact!); setDraft(next); setBaseline(next); setConflict(false); setError(''); }}>Usar contatos atuais</button><button type="button" className="button secondary" disabled={loading || busy || !!pending || !conflictLoaded} onClick={() => { setBaseline(draftOf(contact!)); setConflict(false); setError(''); }}>Manter meu rascunho após conferência</button></div></div>}
        <button type="button" className="button secondary" disabled={loading || busy || !!pending} onClick={() => setReload(value => value + 1)}>Atualizar contatos e descrição</button>
        {editable ? <form onSubmit={save}><fieldset disabled={busy || loading || !!pending || conflict}><label className="field">E-mails do órgão<textarea value={draft.emails} onChange={event => setDraft(previous => ({ ...previous, emails: event.target.value }))} placeholder="Um e-mail por linha" maxLength={16050} /></label><label className="field">Telefones do órgão<textarea value={draft.phones} onChange={event => setDraft(previous => ({ ...previous, phones: event.target.value }))} placeholder="Um telefone por linha, com DDD quando disponível" maxLength={4050} /></label><label className="field">Observações dos contatos do órgão<textarea className="collection-contact-notes" value={draft.notes} onChange={event => setDraft(previous => ({ ...previous, notes: event.target.value }))} maxLength={5000} placeholder="Orientações específicas dos canais de contato" /></label><p className="help-text">O andamento deste atendimento continua no campo Observações do título. Campos de contato ausentes podem permanecer vazios.</p><div className="collection-context-buttons"><button type="submit" className="button">Salvar contatos e confirmar revisão</button>{dirty && <button type="button" className="button secondary" onClick={() => { const next = draftOf(contact!); setDraft(next); setBaseline(next); setError(''); }}>Descartar alterações dos contatos</button>}</div></fieldset></form> : <><p className="help-text">Contatos em leitura.</p>{contact!.notes && <p className="help-text collection-contact-values">Observações dos contatos: {contact!.notes}</p>}</>}
        <div className="collection-context-description"><h3>{context.descriptions.state === 'PENDING_VARIANTS' ? 'Conferir descrição' : 'Descrição do título'}</h3>{context.descriptions.state === 'MISSING' ? <p>Descrição não informada na base de origem.</p> : <>{context.descriptions.state === 'PENDING_VARIANTS' && <p>Há descrições diferentes na origem. Confira as variantes; nenhuma foi escolhida automaticamente.</p>}{context.descriptions.count > context.descriptions.variants.length && <p className="help-text">Exibindo {context.descriptions.variants.length} de {context.descriptions.count} variantes da origem. A lista é parcial; peça à administração a conferência das demais descrições.</p>}<ul className="collection-context-variants">{context.descriptions.variants.map(item => <li key={item.id}><p>{item.description}</p>{item.contract && <small>Contrato: {item.contract}</small>}<small>Origem importada em {collectionDateTime(item.imported_at)}</small></li>)}</ul></>}</div>
      </>}
    </div>
  </details>;
}
