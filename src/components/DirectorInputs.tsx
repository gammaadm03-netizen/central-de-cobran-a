import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { displayDate, displayDateTime, money, officialToday, parseBRLCents } from './Treasury';
import '../director-inputs.css';

const fields = [
  { key: 'turnover_month_cents', label: 'Faturamento mês (exceto COMLURB)', group: 'Comercial' },
  { key: 'turnover_comlurb_cents', label: 'Faturamento COMLURB', group: 'Comercial' },
  { key: 'orders_cents', label: 'Valor de pedido em sistema', group: 'Comercial' },
  { key: 'blocked_orders_cents', label: 'Valor de pedidos bloqueados', group: 'Comercial' },
  { key: 'pending_orders_cents', label: 'Valor total pendência', group: 'Comercial' },
  { key: 'overdue_comlurb_cents', label: 'Atrasado COMLURB', group: 'Financeiro' },
  { key: 'installments_cents', label: 'Parcelamentos', group: 'Obrigações' },
  { key: 'previous_month_taxes_cents', label: 'Impostos do mês passado', group: 'Obrigações' },
] as const;
type FieldKey = typeof fields[number]['key'];
type Values = Record<FieldKey, number | null>;
type Draft = Record<FieldKey, string>;
interface Position {
  id: string; reference_date: string; values: Values; observation: string; created_at: string; created_by: string;
}
const emptyDraft = (): Draft => Object.fromEntries(fields.map(field => [field.key, ''])) as Draft;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function validReference(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > officialToday()) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function fromCents(cents: number | null) {
  if (cents === null) return '';
  const integer = BigInt(cents);
  return `${integer / 100n},${String(integer % 100n).padStart(2, '0')}`;
}
function validPosition(value: unknown, reference: string): value is Position {
  if (!value || typeof value !== 'object') return false;
  const position = value as Position;
  return typeof position.id === 'string' && uuid.test(position.id) && position.reference_date === reference && typeof position.observation === 'string' &&
    typeof position.created_at === 'string' && Number.isFinite(Date.parse(position.created_at)) && typeof position.created_by === 'string' &&
    !!position.values && fields.every(field => position.values[field.key] === null || (Number.isSafeInteger(position.values[field.key]) && position.values[field.key]! >= 0));
}
function totalTurnover(draft: Draft) {
  if (!draft.turnover_month_cents.trim() || !draft.turnover_comlurb_cents.trim()) return null;
  const month = parseBRLCents(draft.turnover_month_cents); const comlurb = parseBRLCents(draft.turnover_comlurb_cents);
  if (month === null || comlurb === null || month < 0 || comlurb < 0) return null;
  const total = BigInt(month) + BigInt(comlurb);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

export default function DirectorInputs({ canWrite, onDashboard }: { canWrite: boolean; onDashboard?: () => void }) {
  const [reference, setReference] = useState(officialToday);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [observation, setObservation] = useState('');
  const [position, setPosition] = useState<Position | null>(null);
  const [loadedDate, setLoadedDate] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saveUncertain, setSaveUncertain] = useState(false);
  const preserveDraft = useRef(false);

  useEffect(() => {
    if (!canWrite) { setLoading(false); return; }
    let active = true;
    const keepDraft = preserveDraft.current;
    preserveDraft.current = false;
    setLoading(true); setReadError(''); setLoadedDate('');
    async function load() {
      try {
        if (!supabase || !validReference(reference)) throw new Error('reference');
        const result = await supabase.rpc('read_director_inputs', { p_reference_date: reference });
        if (result.error || (result.data !== null && !validPosition(result.data, reference))) throw new Error('read');
        if (!active) return;
        const data = result.data as Position | null;
        setPosition(data); setLoadedDate(reference); setSaveUncertain(false);
        if (!keepDraft) {
          setDraft(data ? Object.fromEntries(fields.map(field => [field.key, fromCents(data.values[field.key])])) as Draft : emptyDraft());
          setObservation(data?.observation ?? '');
        }
      } catch {
        if (active) setReadError('Não foi possível consultar a posição desta data. Seus campos foram preservados. Atualize a posição antes de salvar.');
      } finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [canWrite, reference, revision]);

  function changeReference(value: string) {
    preserveDraft.current = false;
    setReference(value); setLoadedDate(''); setPosition(null); setDraft(emptyDraft()); setObservation('');
    setError(''); setSuccess(''); setSaveUncertain(false);
  }
  function refresh() {
    preserveDraft.current = true; setError(''); setRevision(value => value + 1);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || loading || saving || saveUncertain || readError || loadedDate !== reference) return;
    setError(''); setSuccess('');
    const values = {} as Values;
    for (const field of fields) {
      const value = draft[field.key].trim();
      const cents = value ? parseBRLCents(value) : null;
      if (value && (cents === null || cents < 0)) {
        setError(`Confira “${field.label}”: informe valor maior ou igual a zero, com até duas casas decimais, sem arredondamento.`); return;
      }
      values[field.key] = cents;
    }
    if (Object.values(values).every(value => value === null) || !validReference(reference) || !observation.trim() || observation.trim().length > 1000) {
      setError('Informe ao menos um indicador, uma data válida e uma observação de até 1.000 caracteres. Campos vazios permanecem não informados; use 0,00 para confirmar valor zero.'); return;
    }
    if (values.turnover_month_cents !== null && values.turnover_comlurb_cents !== null && BigInt(values.turnover_month_cents) + BigInt(values.turnover_comlurb_cents) > BigInt(Number.MAX_SAFE_INTEGER)) {
      setError('O faturamento geral ultrapassa o limite permitido. Confira os dois valores de faturamento antes de salvar.'); return;
    }
    if (!window.confirm(`Salvar os indicadores do Resumo da Diretoria de ${displayDate(reference)}?\n\nOs campos vazios ficarão não informados. A posição anterior e a alteração serão preservadas no histórico e na auditoria.`)) return;
    setSaving(true);
    try {
      if (!supabase) throw new Error('connection');
      const result = await supabase.rpc('save_director_inputs', { p_reference_date: reference, p_values: values, p_observation: observation.trim(), p_expected_id: position?.id ?? null });
      if (result.error) throw result.error;
      if (typeof result.data !== 'string' || !uuid.test(result.data)) throw new Error('write');
      setSuccess(`Indicadores de ${displayDate(reference)} salvos com histórico e auditoria.`);
      preserveDraft.current = false; setRevision(value => value + 1);
    } catch (failure) {
      const code = typeof failure === 'object' && failure !== null && 'code' in failure ? String(failure.code) : '';
      setSaveUncertain(true);
      setError(code === '40001' ? 'Esta posição foi atualizada por outra pessoa. Atualize a posição, confira os dados salvos e seus campos antes de tentar novamente.' : 'Não foi possível confirmar o salvamento. Seus campos foram mantidos. Atualize a posição e confira os dados salvos antes de tentar novamente.');
    } finally { setSaving(false); }
  }

  if (!canWrite) return <section className="panel"><h2>Resumo da Diretoria</h2><p className="notice">Somente a Gerência Geral autorizada pode informar os indicadores complementares. Consulte o Painel Gerencial para visualizar a posição autorizada.</p></section>;
  const current = loadedDate === reference ? position : null;
  const total = totalTurnover(draft);
  return <div className="director-inputs stack">
    <section className="panel director-inputs-position"><div className="panel-heading"><div><h2>Resumo da Diretoria</h2><p className="muted">Informe os indicadores complementares do relatório diário da Diretoria.</p></div><span className="badge">INFORMAÇÃO MANUAL</span></div>
      <p className="help-text">Caixa, contas a receber, estoque e compra de mercadoria utilizam as bases centrais. Os valores informados abaixo valem somente para a data selecionada e não são repetidos automaticamente em outra data.</p>
      <div className="director-inputs-reference"><label className="field">Data de referência do resumo<input type="date" value={reference} onChange={event => changeReference(event.target.value)} min="1900-01-01" max={officialToday()} disabled={saving} required /></label><button className="button secondary" type="button" disabled={loading || saving} onClick={refresh}>{loading ? 'Consultando posição…' : 'Atualizar posição salva'}</button></div>
      {loading && <p className="help-text" role="status">Carregando indicadores da data selecionada…</p>}
      {!loading && !readError && loadedDate === reference && <p className="director-inputs-state">{current ? `Posição de ${displayDate(reference)} registrada em ${displayDateTime(current.created_at)}. A alteração criará uma nova versão preservando a anterior.` : `Nenhum indicador complementar informado em ${displayDate(reference)}. Valores ausentes não são considerados zero.`}</p>}
      {readError && <p className="alert error" role="alert">{readError}</p>}
      {!loading && !readError && current && <details className="director-inputs-saved"><summary>Conferir valores salvos desta data</summary><dl>{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{current.values[field.key] === null ? 'Não informado' : money(current.values[field.key]!)}</dd></div>)}</dl><p className="help-text director-inputs-observation">Observação registrada: {current.observation}</p></details>}
    </section>
    <section className="panel director-inputs-form"><h2>Informar indicadores da posição</h2><p className="muted">Deixe em branco o que ainda não foi confirmado. Para registrar valor zero, preencha 0,00.</p>
      {error && <p className="alert error" role="alert">{error}</p>}{success && <p className="alert success" role="status">{success}</p>}
      <form className="stack" onSubmit={event => void save(event)}><fieldset disabled={saving || loading || loadedDate !== reference}>
        {(['Comercial', 'Financeiro', 'Obrigações'] as const).map(group => <div className="director-inputs-group" key={group}><h3>{group}</h3><div className="form-grid">{fields.filter(field => field.group === group).map(field => <label className="field" key={field.key}>{field.label} (R$)<input value={draft[field.key]} onChange={event => setDraft(previous => ({ ...previous, [field.key]: event.target.value }))} inputMode="decimal" autoComplete="off" maxLength={24} placeholder="Não informado" /></label>)}</div>{group === 'Comercial' && <div className="director-inputs-total"><span>Faturamento geral</span><strong>{total === null ? 'Aguardando os dois valores de faturamento' : money(total)}</strong><small>Faturamento mês + Faturamento COMLURB</small></div>}</div>)}
        <label className="field">Observação dos indicadores<textarea value={observation} onChange={event => setObservation(event.target.value)} maxLength={1000} required /></label>
        <div className="inline-actions"><button className="button" type="submit" disabled={saving || loading || saveUncertain || !!readError || loadedDate !== reference}>{saving ? 'Salvando indicadores…' : 'Salvar indicadores da Diretoria'}</button>{onDashboard && <button className="button secondary" type="button" disabled={saving} onClick={onDashboard}>Ir para o Painel Gerencial</button>}</div>
      </fieldset></form>
    </section>
  </div>;
}
