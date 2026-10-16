import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { displayDate, displayDateTime, money, officialToday, parseBRLCents, accountName, accountType, type BankPosition, type CashPosition } from './Treasury';
import '../bank-import.css';

interface SupportFile { id: string; file_name: string; file_sha256: string; size_bytes: number; account_id: string | null; reference_date: string; description: string; created_at: string }
const MAX_BYTES = 2 * 1024 * 1024;
const COMPANY_ORDER = ['F2G', 'EASY CLEAN', 'FAST CLEAN', 'ECOPLAST', 'GAMMA', 'LIMPE FÁCIL', 'MY CLEAN'];
const BANK_ORDER = ['BRADESCO', 'BANCO DO BRASIL', 'CORA', 'CAIXA'];
function inputValue(cents: number) { return `${cents < 0 ? '-' : ''}${BigInt(Math.abs(cents)) / 100n},${String(BigInt(Math.abs(cents)) % 100n).padStart(2, '0')}`; }
function validDate(date: string) { return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= '1900-01-01' && Number.isFinite(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date && date <= officialToday(); }
function bytesBase64(bytes: Uint8Array) { let text = ''; for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(text); }

export default function BankImport({ canImport }: { canImport: boolean }) {
  const [date, setDate] = useState(officialToday);
  const [accounts, setAccounts] = useState<BankPosition[]>([]);
  const [loadedDate, setLoadedDate] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [observation, setObservation] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [supportDate, setSupportDate] = useState(officialToday);
  const [supportAccount, setSupportAccount] = useState('');
  const [supportDescription, setSupportDescription] = useState('');
  const [supportFile, setSupportFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportError, setSupportError] = useState('');
  const [supportSuccess, setSupportSuccess] = useState('');
  const [supportHistory, setSupportHistory] = useState<SupportFile[]>([]);
  const [supportPage, setSupportPage] = useState(0);
  const [supportCount, setSupportCount] = useState(0);
  const [supportLoading, setSupportLoading] = useState(false);
  const [supportRevision, setSupportRevision] = useState(0);
  const [downloadId, setDownloadId] = useState('');

  useEffect(() => {
    if (!canImport) return;
    let active = true;
    setLoading(true); setError(''); setAccounts([]); setLoadedDate('');
    async function load() {
      try {
        if (!supabase) throw new Error('connection');
        const result = await supabase.rpc('cash_position', { p_as_of: date });
        if (result.error || !result.data || !Array.isArray(result.data.accounts)) throw new Error('read');
        const position = result.data as CashPosition;
        const ordered = [...position.accounts].sort((a, b) => {
          const aOrder = COMPANY_ORDER.indexOf(a.company); const bOrder = COMPANY_ORDER.indexOf(b.company);
          return (aOrder === -1 ? COMPANY_ORDER.length : aOrder) - (bOrder === -1 ? COMPANY_ORDER.length : bOrder) || a.company.localeCompare(b.company, 'pt-BR') || (BANK_ORDER.includes(a.bank.toLocaleUpperCase('pt-BR')) ? BANK_ORDER.indexOf(a.bank.toLocaleUpperCase('pt-BR')) : BANK_ORDER.length) - (BANK_ORDER.includes(b.bank.toLocaleUpperCase('pt-BR')) ? BANK_ORDER.indexOf(b.bank.toLocaleUpperCase('pt-BR')) : BANK_ORDER.length) || a.bank.localeCompare(b.bank, 'pt-BR') || a.account_label.localeCompare(b.account_label, 'pt-BR');
        });
        if (active) {
          setAccounts(ordered); setLoadedDate(date); setConflict(false);
          setValues(Object.fromEntries(ordered.map(account => [account.id, account.balance_date === date && account.amount_cents !== null ? inputValue(account.amount_cents) : ''])));
        }
      } catch { if (active) setError('Não foi possível carregar as contas bancárias e caixas. Tente atualizar a posição.'); }
      finally { if (active) setLoading(false); }
    }
    void load(); return () => { active = false; };
  }, [date, revision, canImport]);

  useEffect(() => {
    if (!canImport) return;
    let active = true;
    setSupportLoading(true); setSupportHistory([]); setSupportError('');
    async function load() {
      try {
        if (!supabase) throw new Error('connection');
        const result = await supabase.from('bank_support_files').select('id,file_name,file_sha256,size_bytes,account_id,reference_date,description,created_at', { count: 'exact' }).order('created_at', { ascending: false }).range(supportPage * 20, supportPage * 20 + 19);
        if (result.error) throw new Error('read');
        if (active) { setSupportHistory((result.data ?? []) as SupportFile[]); setSupportCount(result.count ?? 0); }
      } catch { if (active) setSupportError('Não foi possível consultar os arquivos de apoio. Confira se a atualização do banco foi aplicada.'); }
      finally { if (active) setSupportLoading(false); }
    }
    void load(); return () => { active = false; };
  }, [canImport, supportPage, supportRevision]);

  const currentAccounts = loadedDate === date ? accounts : [];
  const totals = useMemo(() => {
    let total = 0n; let filled = 0; let invalid = 0;
    for (const account of currentAccounts) {
      const text = values[account.id] ?? ''; if (!text.trim()) continue;
      const cents = parseBRLCents(text); if (cents === null) { invalid += 1; continue; }
      filled += 1; total += BigInt(cents);
    }
    const safe = total <= BigInt(Number.MAX_SAFE_INTEGER) && total >= -BigInt(Number.MAX_SAFE_INTEGER);
    return { filled, invalid, complete: currentAccounts.length > 0 && filled === currentAccounts.length && invalid === 0 && safe, total: safe ? Number(total) : null };
  }, [currentAccounts, values]);

  async function savePosition(event: FormEvent) {
    event.preventDefault();
    if (!canImport || saving || loading || conflict) return;
    setError(''); setSuccess('');
    if (!validDate(date) || !totals.complete || !observation.trim()) { setError('Preencha o saldo de todas as contas, uma data válida e a observação. Saldo zero deve ser informado explicitamente. Use até duas casas decimais.'); return; }
    if (!window.confirm(`Salvar posição de caixa?\n\nData: ${displayDate(date)}\nContas: ${currentAccounts.length}\nTotal: ${money(totals.total!)}\n\nTodos os saldos serão gravados juntos, com histórico e auditoria.`)) return;
    setSaving(true);
    try {
      if (!supabase) throw new Error('connection');
      const result = await supabase.rpc('save_bank_position', { p_balance_date: date, p_positions: currentAccounts.map(account => ({ account_id: account.id, amount_cents: parseBRLCents(values[account.id]), expected_updated_at: account.balance_date === date ? account.updated_at : null })), p_observation: observation.trim() });
      if (result.error) throw result.error;
      // Recarregar a revisão após uma gravação permite que a próxima edição detecte concorrência.
      setObservation(''); setRevision(value => value + 1);
      setSuccess(`Posição de ${displayDate(date)} salva com ${currentAccounts.length} contas, histórico e auditoria.`);
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      if (code === '40001') { setConflict(true); setError('Outra pessoa alterou uma das contas. Nenhum saldo desta operação foi gravado. Seu preenchimento foi mantido para conferência; atualize a posição para carregar os saldos mais recentes antes de tentar novamente.'); }
      else setError('Não foi possível confirmar a gravação. Seu preenchimento foi mantido. Atualize a posição e confira os saldos antes de tentar novamente.');
    } finally { setSaving(false); }
  }

  function reload() {
    if (currentAccounts.length && !window.confirm('Atualizar a posição? O preenchimento atual será substituído pelos saldos já salvos para a data selecionada.')) return;
    setRevision(value => value + 1);
  }

  async function registerSupport(event: FormEvent) {
    event.preventDefault(); if (!canImport || supportBusy) return;
    setSupportError(''); setSupportSuccess('');
    if (!supportFile || supportFile.size === 0 || supportFile.size > MAX_BYTES || !/\.(xlsx|xlsm|xls|csv|ofx|pdf)$/i.test(supportFile.name) || !validDate(supportDate) || !supportDescription.trim()) { setSupportError('Selecione um arquivo não vazio de até 2 MiB (.xlsx, .xlsm, .xls, .csv, .ofx ou .pdf), data válida e descrição.'); return; }
    if (!window.confirm(`Registrar arquivo de apoio?\n\n${supportFile.name}\nReferência: ${displayDate(supportDate)}\n\nO arquivo original será preservado. Este registro não altera saldos nem baixa títulos.`)) return;
    setSupportBusy(true);
    try {
      if (!supabase) throw new Error('connection');
      const bytes = new Uint8Array(await supportFile.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const result = await supabase.rpc('register_bank_support', { p_file_name: supportFile.name, p_file_sha256: sha, p_file_base64: bytesBase64(bytes), p_account_id: supportAccount || null, p_reference_date: supportDate, p_description: supportDescription.trim() });
      if (result.error) throw result.error;
      setSupportFile(null); if (fileInput.current) fileInput.current.value = ''; setSupportDescription(''); setSupportSuccess('Arquivo de apoio registrado. Os saldos não foram alterados.'); setSupportPage(0); setSupportRevision(value => value + 1);
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      setSupportError(code === '23505' ? 'Este arquivo já foi registrado. Confira o histórico antes de enviar novamente.' : 'Não foi possível confirmar o registro do arquivo. Confira o histórico antes de tentar novamente.');
    } finally { setSupportBusy(false); }
  }

  async function download(file: SupportFile) {
    if (downloadId) return; setDownloadId(file.id); setSupportError('');
    try {
      if (!supabase) throw new Error('connection');
      const result = await supabase.rpc('download_bank_support', { p_file_id: file.id });
      if (result.error || typeof result.data?.file_base64 !== 'string' || result.data.file_base64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data.file_base64)) throw new Error('read');
      const bytes = Uint8Array.from(atob(result.data.file_base64), character => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a'); link.href = url; link.download = String(result.data.file_name ?? file.file_name).replace(/[\\/\u0000-\u001f]/g, '_'); document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch { setSupportError('Não foi possível baixar o arquivo de apoio. Tente novamente.'); }
    finally { setDownloadId(''); }
  }

  if (!canImport) return <section className="financial-card"><h2>Caixa / Bancos</h2><p className="notice">Seu perfil permite consulta de saldos. O registro de posições e arquivos de apoio é reservado à Gerência Geral.</p></section>;
  return <div className="financial-page bank-import-page">
    <section className="financial-card"><div className="financial-card-heading"><div><h2>Caixa / Bancos</h2><p className="financial-caption">Informe o saldo de cada conta bancária e caixa da empresa. O total consolidado será usado em Caixa / Bancos, no Painel Gerencial e nas projeções.</p></div><button className="button secondary" disabled={loading || saving} onClick={reload}>Atualizar posição</button></div>
      {error && <p className="alert error" role="alert">{error}</p>}{success && <p className="alert success" role="status">{success}</p>}
      {loading && <p role="status" className="financial-loading">Carregando contas bancárias e caixas…</p>}
      <form onSubmit={event => void savePosition(event)}><fieldset disabled={loading || saving}><div className="bank-import-position-toolbar"><label className="field">Data da posição<input aria-label="Data da posição bancária" type="date" value={date} max={officialToday()} required onChange={event => { if (validDate(event.target.value)) { setDate(event.target.value); setSuccess(''); } }} /></label><div className="bank-import-total" aria-live="polite"><span>SALDO ACUMULADO INFORMADO</span><strong>{totals.complete ? money(totals.total!) : 'POSIÇÃO INCOMPLETA'}</strong><small>{totals.filled} de {currentAccounts.length} contas preenchidas{totals.invalid > 0 ? ` · ${totals.invalid} valor(es) inválido(s)` : ''}</small></div></div>
        <p className="notice">Preencha todas as contas bancárias e caixas das empresas. Aceita saldo positivo, negativo ou zero explícito. Saldos de datas anteriores não são copiados automaticamente.</p>
        <div className="table-scroll"><table className="bank-import-table"><thead><tr><th>Empresa</th><th>Conta / Caixa</th><th>Saldo no dia (R$)</th></tr></thead><tbody>{currentAccounts.map(account => <tr key={account.id}><td><strong>{account.company}</strong></td><td><strong>{accountName(account)}</strong><small className="financial-caption bank-account-label">{accountType(account)}</small>{account.balance_date && account.balance_date !== date && <small className="financial-caption bank-account-label">Último registro: {displayDate(account.balance_date)} · {account.amount_cents === null ? 'não informado' : money(account.amount_cents)}</small>}</td><td><input aria-label={`Saldo ${accountName(account)}`} inputMode="decimal" autoComplete="off" placeholder="Informe o saldo" maxLength={24} value={values[account.id] ?? ''} onChange={event => setValues(previous => ({ ...previous, [account.id]: event.target.value }))} required />{(parseBRLCents(values[account.id] ?? '') ?? 0) < 0 && <small className="bank-account-label cash-coverage-status">{date === officialToday() ? 'Saldo negativo — cobrir hoje' : 'Saldo negativo na data informada'}</small>}</td></tr>)}</tbody></table></div>
        <label className="field bank-import-observation">Observação da posição<textarea value={observation} onChange={event => setObservation(event.target.value)} maxLength={1000} required placeholder="Fonte da conferência e observações sobre a posição." /></label><button className="button" type="submit" disabled={saving || loading || conflict || !totals.complete}>{saving ? 'Salvando posição…' : 'Salvar posição de caixa'}</button></fieldset></form>
    </section>
    <section className="financial-card"><h2>Extrato bancário / apoio de conciliação</h2><p className="financial-caption">Registra uma cópia preservada do arquivo original, com hash e auditoria. O arquivo de apoio não atualiza saldos, não baixa títulos e não executa conciliação automática.</p>
      {supportError && <p className="alert error" role="alert">{supportError}</p>}{supportSuccess && <p className="alert success" role="status">{supportSuccess}</p>}
      <form className="stack" onSubmit={event => void registerSupport(event)}><fieldset disabled={supportBusy}><div className="form-grid"><label className="field full">Arquivo de apoio<input ref={fileInput} aria-label="Arquivo de apoio" type="file" accept=".xlsx,.xlsm,.xls,.csv,.ofx,.pdf" onChange={event => { setSupportFile(event.target.files?.[0] ?? null); setSupportSuccess(''); }} required /><small>Até 2 MiB · .xlsx, .xlsm, .xls, .csv, .ofx ou .pdf.</small></label><label className="field">Data de referência do arquivo<input type="date" value={supportDate} max={officialToday()} onChange={event => setSupportDate(event.target.value)} required /></label><label className="field">Conta do arquivo (opcional)<select value={supportAccount} disabled={loading || supportBusy} onChange={event => setSupportAccount(event.target.value)}><option value="">Todas / não especificada</option>{currentAccounts.map(account => <option key={account.id} value={account.id}>{accountName(account)}</option>)}</select></label><label className="field full">Descrição do arquivo<textarea value={supportDescription} onChange={event => setSupportDescription(event.target.value)} required maxLength={1000} /></label></div><button className="button secondary" type="submit">{supportBusy ? 'Registrando arquivo…' : 'Registrar arquivo de apoio'}</button></fieldset></form>
      <div className="bank-support-history"><div className="financial-card-heading"><h3>Histórico dos arquivos de apoio</h3><button className="button secondary" disabled={supportLoading || supportBusy} onClick={() => setSupportRevision(value => value + 1)}>Atualizar arquivos</button></div>{supportLoading && <p role="status">Carregando arquivos de apoio…</p>}{!supportLoading && supportHistory.length === 0 && <p className="financial-caption">Nenhum arquivo de apoio disponível.</p>}{supportHistory.length > 0 && <div className="table-scroll"><table><thead><tr><th>Arquivo / descrição</th><th>Referência</th><th>Registrado em</th><th>Conta</th><th>Download</th></tr></thead><tbody>{supportHistory.map(file => { const account = accounts.find(item => item.id === file.account_id); return <tr key={file.id}><td>{file.file_name}<small className="bank-account-label financial-caption">{file.description} · {file.size_bytes} bytes</small><small className="bank-file-hash">SHA-256: {file.file_sha256}</small></td><td>{displayDate(file.reference_date)}</td><td>{displayDateTime(file.created_at)}</td><td>{account ? accountName(account) : file.account_id ? 'Conta registrada' : 'Todas / não especificada'}</td><td><button className="button secondary" disabled={Boolean(downloadId)} onClick={() => void download(file)}>{downloadId === file.id ? 'Baixando…' : 'Baixar original'}</button></td></tr>; })}</tbody></table></div>}<div className="pagination"><span>{supportCount} arquivo(s) · Página {supportPage + 1}</span><button className="button secondary" disabled={supportLoading || supportPage === 0} onClick={() => setSupportPage(value => value - 1)}>Anterior</button><button className="button secondary" disabled={supportLoading || (supportPage + 1) * 20 >= supportCount} onClick={() => setSupportPage(value => value + 1)}>Próxima</button></div></div>
    </section>
  </div>;
}
