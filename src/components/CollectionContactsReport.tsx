import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { collectionDate, collectionDateTime } from '../lib/collection-workbench';
import { dateLabel, formatCents } from '../lib/payables';
import '../collection-customer-context.css';

export interface CollectionContactsReportProps { isCollector: boolean; collectorId: string | null; refreshKey?: number }
type Coverage = 'ALL' | 'WITH_CONTACT' | 'MISSING_CONTACT' | 'MISSING_EMAIL' | 'MISSING_PHONE' | 'REVIEWED' | 'NOT_REVIEWED';
type View = 'coverage' | 'changes';
interface Filters { search: string; coverage: Coverage; start: string; end: string; view: View }
interface ContactSnapshot { emails: string[]; phones: string[]; notes: string | null; revision: number; reviewed_at?: string | null; reviewed_by?: string | null }
interface ContactRow {
  customer_key: string; client_name: string; client_document: string | null; emails: string[]; phones: string[]; notes: string | null;
  record_revision: number; manually_edited: boolean; reviewed_at: string | null; reviewed_by: string | null; reviewed_by_name: string | null;
  updated_at: string | null; updated_by: string | null; updated_by_name: string | null; title_count: number; overdue_cents: number; collector_ids: string[];
}
interface ChangeRow {
  event_id: string; customer_key: string; client_name: string; client_document: string | null; created_at: string; created_by: string; created_by_name: string | null;
  before: ContactSnapshot | null; after: ContactSnapshot; action: 'MANUAL_SAVE';
}
interface Report {
  as_of_date: string; server_now: string; snapshot_revision: string; count: number; scope_count: number; with_contact_count: number; reviewed_count: number;
  rows: (ContactRow | ChangeRow)[];
}
const initialFilters: Filters = { search: '', coverage: 'ALL', start: '', end: '', view: 'coverage' };
const coverages: [Coverage, string][] = [['ALL', 'Todos os órgãos'], ['WITH_CONTACT', 'Com algum contato'], ['MISSING_CONTACT', 'Sem nenhum contato'], ['MISSING_EMAIL', 'Sem e-mail'], ['MISSING_PHONE', 'Sem telefone'], ['REVIEWED', 'Revisados'], ['NOT_REVIEWED', 'Não revisados']];
const pageSize = 25;
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const textOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const optionalInstant = (value: unknown) => value === null || instant(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string' && item.length <= 2000);
function validSnapshot(value: unknown): value is ContactSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as ContactSnapshot;
  return strings(snapshot.emails) && strings(snapshot.phones) && textOrNull(snapshot.notes) && nonnegative(snapshot.revision);
}
function isContactRow(row: ContactRow | ChangeRow): row is ContactRow { return 'record_revision' in row; }
function validReport(value: unknown, filters: Filters, limit: number, isCollector: boolean, collectorId: string | null): value is Report {
  if (!value || typeof value !== 'object') return false;
  const result = value as Report;
  if (!collectionDate(result.as_of_date) || !instant(result.server_now) || typeof result.snapshot_revision !== 'string' || !result.snapshot_revision
    || ![result.count, result.scope_count, result.with_contact_count, result.reviewed_count].every(nonnegative)
    || result.with_contact_count > result.scope_count || result.reviewed_count > result.scope_count || !Array.isArray(result.rows) || result.rows.length > limit || result.rows.length > result.count) return false;
  const keys: string[] = [];
  for (const row of result.rows) {
    if (!row || typeof row !== 'object' || typeof row.customer_key !== 'string' || !row.customer_key || typeof row.client_name !== 'string' || !textOrNull(row.client_document)) return false;
    if (filters.view === 'coverage') {
      if (!isContactRow(row) || !strings(row.emails) || !strings(row.phones) || !textOrNull(row.notes) || !nonnegative(row.record_revision) || typeof row.manually_edited !== 'boolean'
        || !optionalInstant(row.reviewed_at) || !optionalInstant(row.updated_at) || ![row.reviewed_by, row.reviewed_by_name, row.updated_by, row.updated_by_name].every(textOrNull)
        || !nonnegative(row.title_count) || !nonnegative(row.overdue_cents) || !Array.isArray(row.collector_ids) || row.collector_ids.some(id => typeof id !== 'string')
        || isCollector && (!collectorId || !row.collector_ids.includes(collectorId))) return false;
      keys.push(row.customer_key);
    } else {
      if (isContactRow(row) || typeof row.event_id !== 'string' || !row.event_id || !instant(row.created_at) || typeof row.created_by !== 'string' || !textOrNull(row.created_by_name)
        || row.action !== 'MANUAL_SAVE' || row.before !== null && !validSnapshot(row.before) || !validSnapshot(row.after)) return false;
      keys.push(row.event_id);
    }
  }
  return new Set(keys).size === keys.length;
}
function reportError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['PGRST202', 'PGRST205', '42883', '42P01', '42703'].includes(code)) return 'O relatório de contatos precisa da atualização do banco. Peça à administração para ativar os contatos da Cobrança.';
  if (code === '40001') return 'Os contatos ou a carteira mudaram durante a consulta. Atualize o relatório e tente novamente. Nenhum arquivo parcial foi gerado.';
  if (code === '42501') return 'Seu perfil não permite consultar estes contatos ou esta carteira.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (code === '22023') return 'Confira os filtros e o período do relatório de contatos.';
  if (error instanceof Error && error.message === 'export_limit') return 'A exportação excede o limite de segurança. Restrinja o nome, a cobertura ou o período e tente novamente.';
  return 'Não foi possível consultar os contatos oficiais. Atualize o relatório e tente novamente; nenhum total foi presumido.';
}
async function readReport(filters: Filters, offset: number, limit: number, isCollector: boolean, collectorId: string | null, signal: AbortSignal, expectedRevision: string | null = null): Promise<Report> {
  const client = supabase;
  if (!client) throw { code: 'PGRST301' };
  if (isCollector && !collectorId) throw { code: '42501' };
  const result = await client.rpc('collection_customer_contact_report', {
    p_search: filters.search, p_collector_id: isCollector ? collectorId : null, p_coverage: filters.coverage,
    p_changed_start: filters.start || null, p_changed_end: filters.end || null, p_changed_by: null,
    p_offset: offset, p_limit: limit, p_view: filters.view, p_expected_revision: expectedRevision,
  }).abortSignal(signal);
  if (result.error) throw result.error;
  if (!validReport(result.data, filters, limit, isCollector, collectorId)) throw new Error('invalid_contacts_report');
  if (expectedRevision !== null && result.data.snapshot_revision !== expectedRevision) throw { code: '40001' };
  return result.data;
}
function emailHref(value: string) {
  const email = value.trim();
  if (email.length > 254 || !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,63}$/i.test(email)) return undefined;
  return `mailto:${encodeURIComponent(email).replace('%40', '@')}`;
}
function phoneHref(value: string) {
  const phone = value.trim().replace(/[\s().-]/g, '');
  return /^\+?\d{7,15}$/.test(phone) ? `tel:${phone}` : undefined;
}
function ContactValues({ values, kind }: { values: string[]; kind: 'email' | 'phone' }) {
  return values.length ? <ul className="collection-contact-values">{values.map((value, index) => {
    const href = kind === 'email' ? emailHref(value) : phoneHref(value);
    return <li key={`${value}:${index}`}>{href ? <a href={href}>{value}</a> : value}</li>;
  })}</ul> : <span className="muted">Não informado</span>;
}
function snapshotLabel(value: ContactSnapshot | null) {
  if (!value) return 'Sem registro manual anterior';
  return `E-mails: ${value.emails.join(' | ') || 'não informados'}\nTelefones: ${value.phones.join(' | ') || 'não informados'}\nObservação: ${value.notes || 'não informada'}\nRevisão: ${value.revision}`;
}
function csvField(value: unknown) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f\ufeff]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function downloadCsv(rows: (ContactRow | ChangeRow)[], view: View, day: string) {
  const headers = view === 'coverage'
    ? ['Órgão / Cliente', 'CNPJ / Documento', 'E-mails', 'Telefones', 'Observação', 'Revisado', 'Revisado em', 'Revisado por', 'Última edição', 'Editado por', 'Revisão', 'Títulos vencidos', 'Valor vencido']
    : ['Órgão / Cliente', 'CNPJ / Documento', 'Data da alteração', 'Autor', 'Ação', 'Revisão anterior', 'E-mails anteriores', 'Telefones anteriores', 'Observação anterior', 'Nova revisão', 'Novos e-mails', 'Novos telefones', 'Nova observação'];
  const lines = rows.map(row => isContactRow(row)
    ? [row.client_name, row.client_document, row.emails.join(' | '), row.phones.join(' | '), row.notes, row.reviewed_at ? 'Sim' : 'Não', row.reviewed_at ? collectionDateTime(row.reviewed_at) : '', row.reviewed_by_name || row.reviewed_by || '', row.updated_at ? collectionDateTime(row.updated_at) : '', row.updated_by_name || row.updated_by || '', row.record_revision, row.title_count, `${Math.floor(row.overdue_cents / 100)},${String(row.overdue_cents % 100).padStart(2, '0')}`]
    : [row.client_name, row.client_document, collectionDateTime(row.created_at), row.created_by_name || row.created_by, 'Edição manual de contatos', row.before?.revision ?? '', row.before?.emails.join(' | ') ?? '', row.before?.phones.join(' | ') ?? '', row.before?.notes ?? '', row.after.revision, row.after.emails.join(' | '), row.after.phones.join(' | '), row.after.notes]);
  const contents = '\uFEFF' + [headers, ...lines].map(line => line.map(csvField).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `Contatos_${view === 'coverage' ? 'Diretorio' : 'Auditoria'}_${day}.csv`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function CollectionContactsReport({ isCollector, collectorId, refreshKey = 0 }: CollectionContactsReportProps) {
  const [draft, setDraft] = useState<Filters>({ ...initialFilters }), [filters, setFilters] = useState<Filters>({ ...initialFilters });
  const [page, setPage] = useState(0), [refresh, setRefresh] = useState(0), [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [exporting, setExporting] = useState(false), [exportStatus, setExportStatus] = useState('');
  const exportAbort = useRef<AbortController | null>(null), mounted = useRef(true);
  const unbound = isCollector && !collectorId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; exportAbort.current?.abort(); }; }, []);
  useEffect(() => {
    exportAbort.current?.abort(); exportAbort.current = null; setExporting(false); setExportStatus('');
    const abort = new AbortController(); setReport(null); setError(''); setLoading(true);
    if (unbound) { setLoading(false); return () => abort.abort(); }
    void readReport(filters, page * pageSize, pageSize, isCollector, collectorId, abort.signal).then(data => {
      if (abort.signal.aborted) return;
      const last = Math.max(0, Math.ceil(data.count / pageSize) - 1);
      if (page > last) setPage(last); else setReport(data);
    }).catch(failure => { if (!abort.signal.aborted) setError(reportError(failure)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [filters, page, refresh, refreshKey, isCollector, collectorId, unbound]);
  function apply(event: FormEvent) {
    event.preventDefault();
    if (exporting) return;
    if (draft.start && !collectionDate(draft.start) || draft.end && !collectionDate(draft.end) || draft.start && draft.end && draft.start > draft.end) {
      setError('Informe um período válido, com a data inicial anterior à final.'); return;
    }
    setFilters({ ...draft, search: draft.search.trim() }); setPage(0);
  }
  async function exportCsv() {
    if (!report || !report.count || loading || exportAbort.current) return;
    const abort = new AbortController(); exportAbort.current = abort;
    const frozen = { ...filters }, expected = report.snapshot_revision;
    setExporting(true); setError(''); setExportStatus('Conferindo a carteira e os contatos para exportação…');
    try {
      const first = await readReport(frozen, 0, 1, isCollector, collectorId, abort.signal, expected);
      if (first.count > 1000000) throw new Error('export_limit');
      const rows: (ContactRow | ChangeRow)[] = [];
      for (let offset = 0, pages = 0; rows.length < first.count; offset += 500, pages++) {
        if (pages >= 2000) throw new Error('export_limit');
        const current = await readReport(frozen, offset, 500, isCollector, collectorId, abort.signal, expected);
        if (abort.signal.aborted) return;
        if (current.count !== first.count || current.as_of_date !== first.as_of_date || !current.rows.length || rows.length + current.rows.length > first.count) throw { code: '40001' };
        rows.push(...current.rows); setExportStatus(`Preparando ${rows.length.toLocaleString('pt-BR')} de ${first.count.toLocaleString('pt-BR')} registro(s)…`);
      }
      const final = await readReport(frozen, 0, 1, isCollector, collectorId, abort.signal, expected);
      const ids = rows.map(row => isContactRow(row) ? row.customer_key : row.event_id);
      if (final.count !== first.count || final.as_of_date !== first.as_of_date || rows.length !== first.count || new Set(ids).size !== rows.length) throw { code: '40001' };
      if (!abort.signal.aborted && mounted.current) {
        downloadCsv(rows, frozen.view, first.as_of_date);
        setExportStatus(`${rows.length.toLocaleString('pt-BR')} registro(s) exportado(s) com os filtros e a carteira autorizada.`);
      }
    } catch (failure) { if (!abort.signal.aborted && mounted.current) { setExportStatus(''); setError(reportError(failure)); } }
    finally { if (exportAbort.current === abort) { exportAbort.current = null; if (mounted.current) setExporting(false); } }
  }
  if (unbound) return <p className="notice" role="status">Vincule seu login à sua carteira para consultar os contatos dos seus órgãos.</p>;
  const pages = Math.max(1, Math.ceil((report?.count ?? 0) / pageSize));
  return <section className="panel collection-contact-report" aria-labelledby="collection-contact-report-title">
    <div className="panel-header"><div><h2 id="collection-contact-report-title">Relatório de contatos</h2><p className="muted">Diretório dos órgãos com títulos vencidos na carteira atual e histórico das edições manuais.</p></div><button type="button" className="button secondary" disabled={loading || exporting} onClick={() => { setPage(0); setRefresh(value => value + 1); }}>Atualizar relatório de contatos</button></div>
    {isCollector && <p className="help-text">A consulta e o arquivo incluem somente os órgãos da sua carteira autorizada.</p>}
    <form className="collection-contact-report-filters" onSubmit={apply}><fieldset disabled={exporting}><div className="form-grid">
      <label className="field">Tipo de consulta de contatos<select value={draft.view} onChange={event => setDraft(previous => ({ ...previous, view: event.target.value as View }))}><option value="coverage">Diretório de contatos</option><option value="changes">Auditoria de alterações</option></select></label>
      <label className="field">Nome do órgão / cliente<input type="search" value={draft.search} maxLength={200} placeholder="Buscar nome ou documento" onChange={event => setDraft(previous => ({ ...previous, search: event.target.value }))} /></label>
      <label className="field">Cobertura dos contatos<select disabled={draft.view === 'changes'} value={draft.coverage} onChange={event => setDraft(previous => ({ ...previous, coverage: event.target.value as Coverage }))}>{coverages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="field">Alterações a partir de<input type="date" min="1900-01-01" max="2199-12-31" value={draft.start} onChange={event => setDraft(previous => ({ ...previous, start: event.target.value }))} /></label>
      <label className="field">Alterações até<input type="date" min="1900-01-01" max="2199-12-31" value={draft.end} onChange={event => setDraft(previous => ({ ...previous, end: event.target.value }))} /></label>
    </div><p className="help-text">A cobertura filtra somente o diretório. A auditoria usa o nome e o período dos eventos. O período usa a última edição no diretório. Revisado indica conferência manual; campo vazio permanece não informado.</p><div className="inline-actions"><button type="submit" className="button" disabled={loading}>Consultar contatos</button><button type="button" className="button secondary" disabled={loading} onClick={() => { setDraft({ ...initialFilters }); setFilters({ ...initialFilters }); setPage(0); }}>Limpar filtros de contatos</button></div></fieldset></form>
    {error && <p className="notice error" role="alert">{error}</p>}{loading && <p className="help-text" role="status">Consultando os contatos oficiais da carteira…</p>}{exportStatus && <p className="help-text" role="status">{exportStatus}</p>}
    <div className="collection-contact-report-summary"><article><h3>Órgãos na carteira pesquisada</h3><strong>{report ? report.scope_count.toLocaleString('pt-BR') : 'Não disponível'}</strong></article><article><h3>Com algum contato</h3><strong>{report ? report.with_contact_count.toLocaleString('pt-BR') : 'Não disponível'}</strong></article><article><h3>Revisados manualmente</h3><strong>{report ? report.reviewed_count.toLocaleString('pt-BR') : 'Não disponível'}</strong></article></div>
    <div className="panel-header"><p className="help-text">{report ? `${report.count.toLocaleString('pt-BR')} ${filters.view === 'coverage' ? 'órgão(s)' : 'alteração(ões)'} no filtro · posição ${dateLabel(report.as_of_date)} · consulta ${collectionDateTime(report.server_now)}` : 'Relatório indisponível.'}</p><button type="button" className="button secondary" disabled={loading || exporting || !report?.count} onClick={() => void exportCsv()}>{exporting ? 'Exportando contatos…' : 'Baixar CSV completo dos contatos'}</button></div>
    <div className="table-wrap" aria-busy={loading}><table className="data-table"><caption>{filters.view === 'coverage' ? 'Diretório de contatos dos órgãos da carteira' : 'Auditoria das edições manuais de contatos'}</caption>
      {filters.view === 'coverage' ? <><thead><tr><th>Órgão / Cliente</th><th>E-mails</th><th>Telefones</th><th>Revisão dos contatos</th><th>Última edição</th><th>Carteira vencida</th><th>Observação</th></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="empty-state">Carregando contatos…</td></tr> : report?.rows.length ? report.rows.map(row => isContactRow(row) && <tr key={row.customer_key}><td><strong>{row.client_name}</strong><div>{row.client_document || 'Documento não informado'}</div></td><td><ContactValues values={row.emails} kind="email" /></td><td><ContactValues values={row.phones} kind="phone" /></td><td>{row.reviewed_at ? <><strong>Revisado</strong><div>{collectionDateTime(row.reviewed_at)}</div><div>{row.reviewed_by_name || row.reviewed_by || 'Autor não informado'}</div></> : 'Não revisado'}<div>Revisão {row.record_revision}</div></td><td>{row.updated_at ? <>{collectionDateTime(row.updated_at)}<div>{row.updated_by_name || row.updated_by || 'Autor não informado'}</div></> : 'Sem edição manual'}</td><td>{row.title_count.toLocaleString('pt-BR')} título(s)<div>{formatCents(row.overdue_cents)}</div></td><td>{row.notes || 'Não informada'}</td></tr>) : <tr><td colSpan={7} className="empty-state">{error ? 'Contatos indisponíveis.' : 'Nenhum órgão para os filtros e a carteira selecionados.'}</td></tr>}</tbody></>
        : <><thead><tr><th>Órgão / Cliente</th><th>Data e autor</th><th>Antes</th><th>Depois</th></tr></thead><tbody>{loading ? <tr><td colSpan={4} className="empty-state">Carregando auditoria…</td></tr> : report?.rows.length ? report.rows.map(row => !isContactRow(row) && <tr key={row.event_id} className="collection-contact-audit"><td><strong>{row.client_name}</strong><div>{row.client_document || 'Documento não informado'}</div></td><td>{collectionDateTime(row.created_at)}<div>{row.created_by_name || row.created_by}</div><small>Edição manual de contatos</small></td><td><p>{snapshotLabel(row.before)}</p></td><td><p>{snapshotLabel(row.after)}</p></td></tr>) : <tr><td colSpan={4} className="empty-state">{error ? 'Auditoria indisponível.' : 'Nenhuma edição manual para os filtros e a carteira selecionados.'}</td></tr>}</tbody></>}
    </table></div>
    <div className="pagination"><span>{report ? `${report.count.toLocaleString('pt-BR')} registro(s) · página ${page + 1} de ${pages}` : 'Paginação indisponível'}</span><button type="button" className="button secondary" disabled={loading || exporting || !report || page === 0} onClick={() => setPage(value => value - 1)}>Contatos anteriores</button><button type="button" className="button secondary" disabled={loading || exporting || !report || page + 1 >= pages} onClick={() => setPage(value => value + 1)}>Próximos contatos</button></div>
  </section>;
}
