import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import '../financial.css';

export interface BankPosition {
  id: string; company: string; bank: string; account_label: string;
  account_type?: 'BANK' | 'CASH'; display_name?: string;
  balance_date: string | null; amount_cents: number | null; updated_at: string | null;
}
export interface CashPosition {
  accounts: BankPosition[]; total_cents: number | null; reported_accounts: number;
  expected_accounts: number; latest_position_date: string | null;
  negative_accounts_count?: number; coverage_required_cents?: number;
}
export interface StockPosition {
  value_cents: number | null; reference_date: string | null; source: 'MANUAL' | 'AUTOMÁTICO' | null;
}

export function officialToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`;
}
export function money(cents: number) {
  // Separar a parte inteira em BigInt preserva centavos até o limite seguro,
  // inclusive quando a divisão por 100 perderia precisão em ponto flutuante.
  const absolute = BigInt(Math.abs(cents));
  return `${cents < 0 ? '-' : ''}R$\u00a0${new Intl.NumberFormat('pt-BR').format(absolute / 100n)},${String(absolute % 100n).padStart(2, '0')}`;
}
export function displayDate(date: string | null | undefined) { return date ? date.slice(0, 10).split('-').reverse().join('/') : 'Não informada'; }
export function displayDateTime(timestamp: string) { return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(timestamp)); }
export function accountName(account: BankPosition) { return account.display_name?.trim() || `${account.company} · ${account.bank}${account.account_label ? ` · ${account.account_label}` : ''}`; }
export function accountType(account: BankPosition) { return account.account_type === 'CASH' ? 'Caixa da empresa' : 'Conta bancária'; }
export function cashCoverage(position: CashPosition | null) {
  const accounts = position?.accounts.filter(account => account.amount_cents !== null && account.amount_cents < 0) ?? [];
  const amount = accounts.reduce((sum, account) => sum + BigInt(-account.amount_cents!), 0n);
  return { accounts, count: position?.negative_accounts_count ?? accounts.length, cents: position?.coverage_required_cents ?? (amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null) };
}
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '1900-01-01';
}
export function parseBRLCents(value: string): number | null {
  const normalized = value.trim();
  if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(normalized)) return null;
  const negative = normalized.startsWith('-');
  const [whole, decimal = ''] = normalized.replace('-', '').replaceAll('.', '').split(',');
  const cents = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents) * (negative ? -1 : 1);
}
function Missing({ stock = false }: { stock?: boolean }) { return <span className="financial-missing">{stock ? 'ESTOQUE AGUARDANDO ATUALIZAÇÃO' : 'SALDOS AGUARDANDO ATUALIZAÇÃO'}</span>; }

export default function Treasury({ canWrite, onStockImport }: { canWrite: boolean; onStockImport?: () => void }) {
  const [date, setDate] = useState(officialToday);
  const [loadedCash, setCash] = useState<CashPosition | null>(null);
  const [loadedDate, setLoadedDate] = useState('');
  const [stock, setStock] = useState<StockPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [balanceDate, setBalanceDate] = useState(officialToday);
  const [amount, setAmount] = useState('');
  const [observation, setObservation] = useState('');
  const [stockDate, setStockDate] = useState(officialToday);
  const [stockAmount, setStockAmount] = useState('');
  const [stockObservation, setStockObservation] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setCash(null); setStock(null);
    const client = supabase;
    async function load() {
      try {
        if (!client) throw new Error('connection');
        const [cashResult, stockResult] = await Promise.all([client.rpc('cash_position', { p_as_of: date }), client.rpc('current_stock')]);
        if (cashResult.error || stockResult.error || !cashResult.data || !Array.isArray(cashResult.data.accounts)) throw new Error('read');
        if (!active) return;
        setCash(cashResult.data as CashPosition); setLoadedDate(date); setStock(stockResult.data as StockPosition | null);
        setAccountId(previous => cashResult.data.accounts.some((account: BankPosition) => account.id === previous) ? previous : cashResult.data.accounts[0]?.id ?? '');
      } catch { if (active) setError('Não foi possível carregar a posição de caixa e estoque. Tente atualizar novamente.'); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [date, revision]);

  // A resposta de uma data anterior nunca deve aparecer sob a nova seleção.
  const cash = loadedDate === date ? loadedCash : null;

  async function saveBalance(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || saving) return;
    setError(''); setSuccess('');
    const cents = parseBRLCents(amount);
    const account = cash?.accounts.find(item => item.id === accountId);
    if (cents === null || !account || !validDate(balanceDate) || balanceDate > officialToday() || !observation.trim()) { setError('Informe conta, data válida, observação e valor com até duas casas decimais. Exemplo: 1.234,56.'); return; }
    if (!window.confirm(`Registrar saldo de conta?\n\n${accountName(account)}\nData: ${displayDate(balanceDate)}\nNovo saldo: ${money(cents)}\n\nA alteração será registrada na auditoria.`)) return;
    setSaving(true);
    try {
      if (!supabase) throw new Error('connection');
      const result = await supabase.rpc('set_bank_balance', { p_account_id: account.id, p_balance_date: balanceDate, p_amount_cents: cents, p_observation: observation.trim(), p_expected_updated_at: account.balance_date === balanceDate ? account.updated_at : null });
      if (result.error) throw result.error;
      setAmount(''); setObservation(''); setSuccess('Saldo registrado com histórico e auditoria.'); setDate(balanceDate); setRevision(value => value + 1);
    } catch (failure) {
      const code = typeof failure === 'object' && failure !== null && 'code' in failure ? String(failure.code) : '';
      setError(code === '40001' ? 'Esse saldo foi atualizado por outra pessoa. Atualize a posição e confira os valores antes de tentar novamente.' : 'Não foi possível registrar o saldo. Atualize a posição antes de tentar novamente.');
    } finally { setSaving(false); }
  }

  async function saveStock(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || saving) return;
    setError(''); setSuccess('');
    const cents = parseBRLCents(stockAmount);
    if (cents === null || cents < 0 || !validDate(stockDate) || stockDate > officialToday() || !stockObservation.trim()) { setError('Informe estoque maior ou igual a zero, data válida e observação. Use até duas casas decimais.'); return; }
    if (!window.confirm(`Salvar posição manual de estoque?\n\nReferência: ${displayDate(stockDate)}\nValor: ${money(cents)}\n\nEssa posição ficará identificada como MANUAL e será auditada.`)) return;
    setSaving(true);
    try {
      if (!supabase) throw new Error('connection');
      const result = await supabase.rpc('save_manual_stock', { p_value_cents: cents, p_reference_date: stockDate, p_observation: stockObservation.trim() });
      if (result.error) throw result.error;
      setStockAmount(''); setStockObservation(''); setSuccess('Estoque manual registrado com histórico e auditoria.'); setRevision(value => value + 1);
    } catch { setError('Não foi possível registrar o estoque. Atualize a posição antes de tentar novamente.'); }
    finally { setSaving(false); }
  }

  const coverage = cashCoverage(cash);
  const isToday = date === officialToday();
  const groups = cash ? Array.from(new Set(cash.accounts.map(account => account.company))) : [];
  return <div className="financial-page treasury-page">
    <div className="financial-toolbar"><div><p className="financial-subtitle">Contas bancárias e caixas das empresas · posição centralizada do grupo.</p><p className="financial-caption">Cada conta considera o último saldo informado até a data selecionada.</p></div><div className="inline-actions"><label className="field">Data da posição<input aria-label="Data da posição" type="date" value={date} max={officialToday()} disabled={saving} onChange={event => { if (event.target.value && validDate(event.target.value)) setDate(event.target.value); }} /></label><button className="button secondary" disabled={loading || saving} onClick={() => setRevision(value => value + 1)}>Atualizar posição</button></div></div>
    {error && <p className="alert error" role="alert">{error}</p>}{success && <p className="alert success" role="status">{success}</p>}
    {loading && <p className="financial-loading" role="status">Carregando posição financeira…</p>}
    <div className="financial-kpis treasury-kpis"><article className="financial-kpi"><span className="financial-kpi-label">CAIXA TOTAL</span><strong>{loading ? 'Carregando…' : cash?.total_cents != null ? money(cash.total_cents) : <Missing />}</strong><small>{cash ? `${cash.reported_accounts} de ${cash.expected_accounts} contas com saldo informado` : 'Consolidado das contas bancárias e caixas das empresas'}</small></article><article className="financial-kpi"><span className="financial-kpi-label">ESTOQUE INFORMADO</span><strong>{loading ? 'Carregando…' : stock?.value_cents != null ? money(stock.value_cents) : <Missing stock />}</strong><small>{stock?.value_cents != null ? `${stock.source ?? 'MANUAL'} · Referência ${displayDate(stock.reference_date)}` : 'Ausência de informação não é considerada saldo zero.'}</small>{onStockImport && <button type="button" className="financial-text-button" onClick={onStockImport}>Informar estoque em Importar Bases →</button>}</article></div>
    {!loading && cash && cash.total_cents === null && <p className="notice">A posição está incompleta. O caixa consolidado ficará disponível após informar o saldo de todas as contas.</p>}
    {!loading && coverage.count > 0 && <section className="financial-card cash-coverage-alert" role="alert"><div className="financial-card-heading"><div><h2>{isToday ? 'Contas negativas — cobrir hoje' : 'Cobertura na data consultada'}</h2><p className="financial-caption">{coverage.count} conta(s) com saldo negativo registrado. Saldos positivos de outras contas não reduzem este alerta.</p></div><strong>{coverage.cents !== null ? money(coverage.cents) : 'Valor acima do limite de exibição'}</strong></div><ul>{coverage.accounts.map(account => <li key={account.id}><div><strong>{accountName(account)}</strong><small>{isToday && account.balance_date !== date ? `Registro anterior: confira e atualize hoje · ${displayDate(account.balance_date)}` : `Saldo registrado em ${displayDate(account.balance_date)}`}</small></div><span>{money(account.amount_cents!)}</span></li>)}</ul>{cash?.total_cents === null && <p className="financial-caption">A posição está incompleta; o alerta considera os saldos negativos já informados.</p>}</section>}
    {!loading && groups.map(company => {
      const accounts = cash!.accounts.filter(account => account.company === company);
      const complete = accounts.every(account => account.amount_cents !== null);
      const subtotal = complete ? Number(accounts.reduce((total, account) => total + BigInt(account.amount_cents!), 0n)) : null;
      return <section className="financial-card bank-company" key={company}><div className="financial-card-heading"><h2>{company}</h2><span className="bank-subtotal">Subtotal: {subtotal !== null ? money(subtotal) : 'aguardando saldos'}</span></div><div className="table-scroll"><table><thead><tr><th>Conta / Caixa</th><th>Data do saldo</th><th className="financial-numeric">Saldo informado</th></tr></thead><tbody>{accounts.map(account => <tr key={account.id}><td><strong>{account.display_name || account.bank}</strong><small className="financial-caption bank-account-label">{accountType(account)}{account.account_type !== 'CASH' && account.account_label ? ` · ${account.account_label}` : ''}</small></td><td>{displayDate(account.balance_date)}</td><td className={`financial-numeric ${account.amount_cents != null && account.amount_cents < 0 ? 'financial-negative' : ''}`}>{account.amount_cents !== null ? money(account.amount_cents) : <Missing />}{account.amount_cents !== null && account.amount_cents < 0 && <small className="bank-account-label cash-coverage-status">{isToday ? account.balance_date === date ? 'Cobrir hoje' : 'Registro anterior: conferir hoje' : 'Cobertura na data consultada'}</small>}</td></tr>)}</tbody></table></div></section>;
    })}
    {canWrite && <div className="treasury-forms"><section className="financial-card"><h2>Registrar saldo de conta</h2><p className="financial-caption">Data, responsável, valor anterior e novo valor ficam registrados na auditoria.</p><form className="stack" onSubmit={event => void saveBalance(event)}><fieldset disabled={saving || loading || !cash}><div className="form-grid"><label className="field full">Conta / Caixa<select aria-label="Conta / Caixa" value={accountId} onChange={event => setAccountId(event.target.value)} required>{cash?.accounts.map(account => <option key={account.id} value={account.id}>{accountName(account)}</option>)}</select></label><label className="field">Data do saldo<input type="date" value={balanceDate} onChange={event => setBalanceDate(event.target.value)} max={officialToday()} required /></label><label className="field">Saldo (R$)<input inputMode="decimal" autoComplete="off" placeholder="1.234,56" value={amount} onChange={event => setAmount(event.target.value)} maxLength={24} required /></label><label className="field full">Observação do saldo<textarea value={observation} onChange={event => setObservation(event.target.value)} maxLength={1000} required /></label></div><button className="button" disabled={saving || loading} type="submit">{saving ? 'Registrando…' : 'Registrar saldo'}</button></fieldset></form></section><section className="financial-card"><h2>Estoque manual</h2><p className="financial-caption">Use o valor conferido no sistema de estoque. A mesma posição pode ser informada em Importar Bases → Estoque.</p><form className="stack" onSubmit={event => void saveStock(event)}><fieldset disabled={saving || loading}><div className="form-grid"><label className="field">Data de referência<input type="date" value={stockDate} onChange={event => setStockDate(event.target.value)} max={officialToday()} required /></label><label className="field">Valor do estoque (R$)<input inputMode="decimal" autoComplete="off" placeholder="1.234,56" value={stockAmount} onChange={event => setStockAmount(event.target.value)} maxLength={24} required /></label><label className="field full">Observação do estoque<textarea value={stockObservation} onChange={event => setStockObservation(event.target.value)} maxLength={1000} required /></label></div><button className="button" disabled={saving || loading} type="submit">{saving ? 'Registrando…' : 'Salvar estoque manual'}</button></fieldset></form></section></div>}
  </div>;
}
