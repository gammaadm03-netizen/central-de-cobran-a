import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { dateLabel, formatCents } from '../lib/payables';
import { monthBounds } from '../lib/financial-dates';
import { officialToday } from './Treasury';
import { collectorBands, sellerBands, commissionEligibility, sellerPolicyLabels, isCommissionReport, isUuid, commissionError, percentToBps, commissionWorkbook, formatCommissionRate,
  type CommissionKind, type CommissionReport, type CommissionRow, type SellerPolicy } from '../lib/commissions';
import '../receivable-commissions.css';
import PendingCollectionCommissions from './PendingCollectionCommissions';

type Filters = { kind: CommissionKind; start: string; end: string; subject: string; band: string };
const percent = (value: number | null | undefined) => value == null ? 'Pendente' : `${(value / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
const assessedMoney = (value: number | null | undefined) => value == null ? 'Pendente' : formatCents(value);
const timestamp = (value: string) => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
export default function ReceivableCommissions({ canConfigure = false, canExport = false, onCollections }: { canConfigure?: boolean; canExport?: boolean; onCollections?: () => void }) {
  const initial = monthBounds(officialToday().slice(0, 7));
  const [kind, setKind] = useState<CommissionKind>('COLLECTOR');
  const [month, setMonth] = useState(officialToday().slice(0, 7));
  const [start, setStart] = useState(initial.start), [end, setEnd] = useState(initial.end), [subject, setSubject] = useState(''), [band, setBand] = useState('');
  const [filters, setFilters] = useState<Filters>({ kind: 'COLLECTOR', ...initial, subject: '', band: '' });
  const [report, setReport] = useState<CommissionReport | null>(null), [options, setOptions] = useState<CommissionReport['options']>([]);
  const [page, setPage] = useState(0), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [selected, setSelected] = useState<CommissionRow | null>(null);
  const [configuring, setConfiguring] = useState(false), [effective, setEffective] = useState(officialToday()), [reason, setReason] = useState('');
  const [eligible, setEligible] = useState<string[]>([]), [employee, setEmployee] = useState(''), [policy, setPolicy] = useState<SellerPolicy>('COMMERCIAL'), [minimum, setMinimum] = useState('10');
  const [saved, setSaved] = useState<{ id: string; created_at: string; report: CommissionReport } | null>(null);
  const locked = useRef(false), mounted = useRef(true), actionAbort = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; actionAbort.current?.abort(); }; }, []);
  useEffect(() => {
    if (saved) return;
    const client = supabase; if (!client) { setLoading(false); setError('Conexão indisponível.'); return; }
    const abort = new AbortController(); setLoading(true); setError(''); setReport(null); setSelected(null);
    void Promise.resolve(client.rpc('commissions_report', { p_kind: filters.kind, p_start: filters.start, p_end: filters.end, p_subject: filters.subject || null, p_band: filters.band || null, p_offset: page * 25, p_limit: 25 }).abortSignal(abort.signal).retry(false)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error) throw result.error;
      if (!isCommissionReport(result.data) || result.data.kind !== filters.kind || result.data.start !== filters.start || result.data.end !== filters.end || result.data.rows.length > 25) throw new Error('invalid_response');
      setOptions(result.data.options);
      const last = Math.max(0, Math.ceil(result.data.count / 25) - 1);
      if (page > last) setPage(last); else setReport(result.data);
    }).catch(failure => { if (!abort.signal.aborted) setError(commissionError(failure)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [filters, page, refresh, saved]);
  function switchKind(next: CommissionKind) {
    if (busy || next === kind) return;
    setKind(next); setSubject(''); setBand(''); setOptions([]); setSaved(null); setConfiguring(false); setMessage(''); setSelected(null); setReport(null); setPage(0);
    setFilters({ kind: next, start, end, subject: '', band: '' });
  }
  function query(event: FormEvent) {
    event.preventDefault(); if (loading || busy) return;
    if (!start || !end || start > end || (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400000 > 3660) { setError('Informe um período válido de até dez anos.'); return; }
    setSaved(null); setPage(0); setMessage(''); setFilters({ kind, start, end, subject, band }); setRefresh(v => v + 1);
  }
  async function action(task: (signal: AbortSignal) => Promise<void>) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(''); setMessage('');
    const abort = new AbortController(); actionAbort.current = abort;
    try { await task(abort.signal); } catch (failure) { if (mounted.current && !abort.signal.aborted) setError(commissionError(failure, true)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  function configure() {
    const latest = report?.rule_versions.filter(v => v.kind === 'COLLECTOR')[0];
    setEligible(latest?.config.eligible_collector_ids ?? []); setEmployee(subject); setReason(''); setEffective(officialToday()); setMinimum('10'); setPolicy('COMMERCIAL');
    setConfiguring(v => !v); setMessage('');
  }
  function configureEmployee(next: string) {
    setEmployee(next);
    const latest = report?.rule_versions.find(v => v.subject === next);
    setPolicy(latest?.config.policy ?? 'COMMERCIAL');
    setMinimum(latest?.config.minimum_margin_bps == null ? '10' : String(latest.config.minimum_margin_bps / 100));
  }
  function configurePolicy(next: SellerPolicy) { setPolicy(next); setMinimum(next === 'MATEUS' || next === 'KEVYN' ? effective >= '2026-10-01' ? '14' : '10' : next === 'NONE' ? '0' : '10'); }
  function saveConfiguration(event: FormEvent) {
    event.preventDefault(); if (!canConfigure || !supabase || busy) return;
    let minimumBps = 1000;
    try { if (kind === 'SELLER') minimumBps = percentToBps(minimum); } catch { setError('Informe a margem mínima confirmada, de 0% a 100%, com até duas casas decimais.'); return; }
    if (!effective || !reason.trim() || kind === 'SELLER' && !employee) { setError('Preencha a vigência, a justificativa e o funcionário, quando aplicável.'); return; }
    const client = supabase;
    void action(async signal => {
      const result = await client.rpc('configure_commission_rule', { p_kind: kind, p_effective_from: effective, p_subject: kind === 'COLLECTOR' ? '' : employee,
        p_config: kind === 'COLLECTOR' ? { eligible_collector_ids: eligible } : { policy, minimum_margin_bps: minimumBps }, p_reason: reason.trim() }).abortSignal(signal).retry(false);
      if (result.error) throw result.error; if (!isUuid(result.data)) throw new Error('invalid_response');
      if (!mounted.current || signal.aborted) return;
      setConfiguring(false); setMessage('Regra salva com vigência. As apurações já salvas continuam preservadas.'); setRefresh(v => v + 1);
    });
  }
  function restoreSellerPolicy() {
    if (!canConfigure || !supabase || !employee || !reason.trim() || busy) { setError('Selecione funcionário, política e justificativa para recuperar as regras.'); return; }
    const client = supabase;
    void action(async signal => {
      const result = await client.rpc('restore_seller_commission_policy', { p_subject: employee, p_policy: policy, p_reason: reason.trim() }).abortSignal(signal).retry(false);
      if (result.error) throw result.error;
      if (!result.data || !Array.isArray(result.data.rule_ids) || !result.data.rule_ids.every(isUuid) || !Number.isSafeInteger(result.data.created_count)) throw new Error('invalid_response');
      if (!mounted.current || signal.aborted) return;
      setConfiguring(false); setMessage('Regras recuperadas com vigência: setembro/2026 e, para Mateus e Kevyn, margem mínima de 14% desde 01/10/2026. Versões já cadastradas foram preservadas.'); setRefresh(v => v + 1);
    });
  }
  function saveAssessment() {
    if (!canConfigure || !supabase || !report || saved || busy) return;
    const basis = report, client = supabase;
    void action(async signal => {
      const result = await client.rpc('save_commission_assessment', { p_kind: basis.kind, p_start: basis.start, p_end: basis.end, p_subject: basis.subject, p_band: basis.band, p_expected_revision: basis.revision }).abortSignal(signal).retry(false);
      if (result.error) throw result.error; if (!isUuid(result.data)) throw new Error('invalid_response');
      if (!mounted.current || signal.aborted) return;
      setMessage('Apuração salva com a base e as versões das regras. Nenhum pagamento foi gerado.'); setRefresh(v => v + 1);
    });
  }
  function openAssessment(id: string) {
    if (!supabase || busy) return; const client = supabase;
    void action(async signal => {
      const result = await client.rpc('commission_assessment', { p_id: id }).abortSignal(signal).retry(false);
      if (result.error) throw result.error;
      const value = result.data;
      if (!value || !isUuid(value.id) || value.id !== id || typeof value.created_at !== 'string' || !isCommissionReport(value.report)) throw new Error('invalid_response');
      if (!mounted.current || signal.aborted) return;
      setSaved(value); setSelected(null); setConfiguring(false); setPage(0); setLoading(false);
    });
  }
  function exportReport() {
    if (!canExport || !supabase || busy || (!report && !saved)) return;
    const basis = saved?.report ?? report!, client = supabase;
    void action(async signal => {
      let whole = basis;
      if (!saved) {
        if (basis.count > 50000) throw new Error('export_limit');
        const rows: CommissionRow[] = [];
        for (let offset = 0; offset < Math.max(1, basis.count); offset += 1000) {
          const result = await client.rpc('commissions_report', { p_kind: basis.kind, p_start: basis.start, p_end: basis.end, p_subject: basis.subject, p_band: basis.band, p_offset: offset, p_limit: 1000 }).abortSignal(signal).retry(false);
          if (result.error) throw result.error;
          if (!isCommissionReport(result.data) || result.data.revision !== basis.revision || result.data.count !== basis.count || result.data.rows.length > 1000) throw { code: '40001' };
          rows.push(...result.data.rows);
        }
        if (rows.length !== basis.count || new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('invalid_response');
        whole = { ...basis, rows };
      }
      const workbook = await commissionWorkbook(whole), bytes = await workbook.xlsx.writeBuffer();
      if (!mounted.current || signal.aborted) return;
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `Comissoes_${whole.kind === 'COLLECTOR' ? 'Cobradoras' : 'Vendedores'}_${whole.start}_${whole.end}.xlsx`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage('Relatório exportado com todos os itens do filtro e a versão de cada regra.');
    });
  }
  const view = saved?.report ?? report, collector = kind === 'COLLECTOR', bands = collector ? collectorBands : sellerBands;
  const rows = saved ? saved.report.rows.slice(page * 25, (page + 1) * 25) : report?.rows ?? [];
  return <div className="stack receivable-commissions">
    <div className="tabs" role="tablist" aria-label="Tipos de comissões"><button role="tab" aria-selected={collector} disabled={busy} onClick={() => switchKind('COLLECTOR')}>Comissões — Cobradoras</button><button role="tab" aria-selected={!collector} disabled={busy} onClick={() => switchKind('SELLER')}>Comissões — Vendedores</button></div>
    <section className="panel commission-source"><div><h2>{collector ? 'Fonte da apuração: Central de Cobrança' : 'Fonte da apuração: Fechamento de Faturamento'}</h2><p className="muted">{collector ? 'Somente títulos trabalhados na Cobrança com recebimento validado. A base é o valor efetivamente recebido e a faixa considera o atraso na data real do recebimento.' : 'Itens do fechamento oficial, pela data de emissão e pelo funcionário. A margem para a regra do vendedor é recalculada após a comissão; a aba Margens preserva o fechamento importado.'}</p></div>{collector && onCollections && <button className="button secondary" onClick={onCollections}>Abrir Central de Cobrança →</button>}</section>
    <section className="panel"><div className="panel-header"><h2>{collector ? 'Apuração de comissões das cobradoras' : 'Apuração de comissões dos vendedores'}</h2><div className="inline-actions"><button className="button secondary" disabled={loading || busy || !!saved} onClick={() => { setMessage(''); setRefresh(v => v + 1); }}>Atualizar comissões</button>{canConfigure && !saved && <button className="button secondary" disabled={loading || busy || !report} onClick={configure}>Configurar comissões</button>}</div></div>
      <form className="form-grid" onSubmit={query}><label className="field">{collector ? 'Mês de recebimento' : 'Mês de faturamento'}<input type="month" min="1900-01" max="2199-12" value={month} disabled={busy} onChange={e => { setMonth(e.target.value); if (e.target.value) { const bounds = monthBounds(e.target.value); setStart(bounds.start); setEnd(bounds.end); } }} /></label><label className="field">{collector ? 'Recebimento inicial' : 'Emissão inicial'}<input type="date" min="1900-01-01" max="2199-12-31" required value={start} disabled={busy} onChange={e => { setStart(e.target.value); setMonth(''); }} /></label><label className="field">{collector ? 'Recebimento final' : 'Emissão final'}<input type="date" min="1900-01-01" max="2199-12-31" required value={end} disabled={busy} onChange={e => { setEnd(e.target.value); setMonth(''); }} /></label><label className="field">{collector ? 'Cobradora da comissão' : 'Vendedor da comissão'}<select value={subject} disabled={busy} onChange={e => setSubject(e.target.value)}><option value="">{collector ? 'Todas as responsáveis' : 'Todos os funcionários'}</option>{options.map(o => <option value={o.id} key={o.id}>{o.name}</option>)}</select></label><label className="field">{collector ? 'Faixa de atraso' : 'Faixa de margem da apuração'}<select value={band} disabled={busy} onChange={e => setBand(e.target.value)}><option value="">Todas</option>{Object.entries(bands).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><button className="button" disabled={loading || busy}>Consultar comissões</button><button type="button" className="button secondary" disabled={loading || busy} onClick={() => { setSubject(''); setBand(''); setSaved(null); setPage(0); setFilters({ kind, start, end, subject: '', band: '' }); }}>Limpar filtros</button></form>
      {error && <p className="notice error" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}{loading && !saved && <p role="status">Carregando comissões…</p>}
      {saved && <div className="notice commission-snapshot"><strong>Apuração salva em {timestamp(saved.created_at)}</strong><span>{dateLabel(saved.report.start)} a {dateLabel(saved.report.end)} · base e regras preservadas</span><button className="button secondary" disabled={busy} onClick={() => { setSaved(null); setPage(0); setSelected(null); }}>Voltar à base atual</button></div>}
      {view && <><div className="commission-base-cards"><article><h3>{collector ? 'Recebido validado' : 'Faturamento no filtro'}</h3><strong>{formatCents(view.total_amount_cents)}</strong><small>{view.count} {collector ? 'recebimento(s) trabalhado(s)' : 'item(ns) do fechamento'}</small></article><article><h3>Comissão apurada</h3><strong>{formatCents(view.commission_cents)}</strong><small>{view.pending_count ? `${view.pending_count} item(ns) pendente(s); valor parcial` : 'Apuração completa no filtro'}</small></article><article><h3>{collector ? 'Títulos comissionáveis' : 'Margem após comissão'}</h3><strong>{collector ? view.assessed_count : formatCents(view.margin_cents)}</strong><small>{collector ? 'Somente regras e responsáveis habilitadas' : 'Calculada somente para itens com regra resolvida'}</small></article><article><h3>{collector ? 'Atraso médio no recebimento' : 'Margem calculada %'}</h3><strong>{collector ? `${view.average_delay_days.toLocaleString('pt-BR')} dias` : view.pending_count ? 'Pendente' : percent(view.total_amount_cents ? view.margin_cents / view.total_amount_cents * 10000 : 0)}</strong><small>{collector ? 'Considera a data efetiva do recebimento' : 'Margem calculada ÷ faturamento'}</small></article></div>
      {view.pending_count > 0 && <p className="notice">{view.pending_count} item(ns) precisa(m) de regra com vigência ou conferência. A comissão exibida contém somente os itens resolvidos. {canConfigure ? 'Abra Configurar comissões para habilitar as responsáveis e definir as políticas dos vendedores.' : 'A administração pode conferir as regras e suas vigências.'}</p>}
      <div className="inline-actions commission-report-actions">{canExport && <button className="button secondary" disabled={busy || loading && !saved} onClick={exportReport}>Baixar Excel das comissões</button>}{canConfigure && !saved && <button className="button" disabled={busy || loading || !view.complete || !view.count || view.count > 5000} onClick={saveAssessment}>Salvar apuração</button>}<span className="help-text">Apuração de comissão; não representa pagamento.</span></div></>}
    </section>
    {collector && <PendingCollectionCommissions refreshKey={refresh} />}
    {configuring && canConfigure && report && <section className="panel" aria-labelledby="commission-configuration"><h2 id="commission-configuration">Regras e vigências de comissões</h2><p className="muted">Selecione os vínculos reais da Central. Cada alteração cria uma nova versão; apurações salvas mantêm a regra usada.</p><form onSubmit={saveConfiguration} className="stack">
      {collector ? <fieldset><legend>Cobradoras que participam da apuração</legend><div className="commission-agent-options">{report.options.filter(o => o.enabled).map(o => <label key={o.id}><input type="checkbox" checked={eligible.includes(o.id)} disabled={busy} onChange={e => setEligible(v => e.target.checked ? [...v, o.id] : v.filter(id => id !== o.id))} />{o.name}</label>)}</div><p className="help-text">A configuração utiliza os cadastros existentes; nenhuma pessoa é vinculada automaticamente pelo nome.</p></fieldset>
      : <div className="form-grid"><label className="field">Funcionário do fechamento<select required value={employee} disabled={busy} onChange={e => configureEmployee(e.target.value)}><option value="">Selecione</option>{report.options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label><label className="field">Política do vendedor<select value={policy} disabled={busy} onChange={e => configurePolicy(e.target.value as SellerPolicy)}>{Object.entries(sellerPolicyLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label className="field">Margem mínima confirmada (%)<input inputMode="decimal" required value={minimum} readOnly={!['MATEUS', 'KEVYN'].includes(policy)} disabled={busy} onChange={e => setMinimum(e.target.value)} /></label></div>}
      {!collector && <p className="notice">Mateus e Kevyn: margem mínima de 10% em setembro/2026 e 14% a partir de 01/10/2026, conforme confirmado. Use Recuperar regras confirmadas para registrar as duas vigências; configurações já cadastradas serão preservadas.</p>}
      <div className="form-grid"><label className="field">Vigência a partir de<input type="date" required min="1900-01-01" max="2199-12-31" value={effective} disabled={busy} onChange={e => setEffective(e.target.value)} /></label><label className="field">Justificativa da regra<textarea required maxLength={2000} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} /></label></div><div className="inline-actions"><button className="button" disabled={busy}>Salvar regra com vigência</button>{!collector && <button type="button" className="button secondary" disabled={busy || !employee || !reason.trim()} onClick={restoreSellerPolicy}>Recuperar regras confirmadas</button>}<button type="button" className="button secondary" disabled={busy} onClick={() => setConfiguring(false)}>Cancelar configuração</button></div>
    </form></section>}
    {view && <><div className="commission-summary-layout"><section className="panel"><h2>{collector ? 'Resumo por cobradora' : 'Resumo por vendedor'}</h2><div className="table-wrap"><table><caption>{collector ? 'Comissões por cobradora' : 'Comissões por vendedor'}</caption><thead><tr><th>Responsável</th><th>{collector ? 'Recebido validado' : 'Venda'}</th><th>Itens</th><th>Comissão</th><th>Pendentes</th></tr></thead><tbody>{view.summaries.length ? view.summaries.map((s, i) => <tr key={s.subject ?? `none-${i}`}><td>{s.subject_name || 'Não informado'}</td><td>{formatCents(s.amount_cents)}</td><td>{s.count}</td><td>{assessedMoney(s.commission_cents)}</td><td>{s.pending_count}</td></tr>) : <tr><td colSpan={5}>Nenhum item no filtro.</td></tr>}</tbody></table></div></section>
      <section className="panel"><h2>{collector ? 'Regra de comissão por faixa' : 'Políticas de comissão dos vendedores'}</h2>{collector ? <><p className="notice">Cálculo proporcional: recebido na faixa ÷ referência × comissão de referência. Até 30 dias não gera comissão. Arredondamento por título ao centavo.</p><div className="table-wrap"><table><caption>Faixas da comissão de cobrança</caption><thead><tr><th>Faixa</th><th>Referência</th><th>Comissão de referência</th><th>Taxa</th></tr></thead><tbody>{view.collector_bands.map(b => <tr key={b.band}><td>{b.label}</td><td>{b.reference_cents ? formatCents(b.reference_cents) : '—'}</td><td>{formatCents(b.commission_reference_cents)}</td><td>{b.reference_cents ? `${(b.commission_reference_cents / b.reference_cents * 100).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%` : '0%'}</td></tr>)}</tbody></table></div></> : <div className="commission-policy-description"><p><strong>Comercial:</strong> margem abaixo de 10%: sem comissão; até 15%: 0,50%; até 20%: 1%; até 25%: 1,50%; até 30%: 2%; acima: 2,50%.</p><p><strong>Grandes Contas:</strong> mínimo da política até menos de 17%: 0,40%; até 30%: 0,60%; até 35%: 0,80%; acima: 1%.</p><p><strong>Mateus:</strong> Grandes Contas com mínimo de 10% em setembro/2026 e 14% desde outubro/2026; COMLURB: 0,30%. <strong>Kevyn:</strong> 0,40% a partir de 10% em setembro/2026 e 14% desde outubro/2026.</p><p><strong>Francisco:</strong> PRIVADO segue Comercial; GRANDES CONTAS — FRANCISCO/WELLINGTON segue Grandes Contas. Outros centros não geram comissão nessa política.</p><p className="help-text">A faixa usa a margem após a própria comissão. Um limite sem taxa consistente fica pendente para conferência, preservando o valor recebido no fechamento.</p></div>}</section></div>
      {collector && <section className="panel"><h2>Apuração por faixa</h2><div className="table-wrap"><table><caption>Resultado por faixa de atraso</caption><thead><tr><th>Faixa</th><th>Recebido validado</th><th>Títulos</th><th>Comissão</th><th>Pendentes</th></tr></thead><tbody>{view.bands.map((b, i) => <tr key={b.band ?? i}><td>{collectorBands[b.band as keyof typeof collectorBands] ?? 'Sem faixa'}</td><td>{formatCents(b.amount_cents)}</td><td>{b.count}</td><td>{assessedMoney(b.commission_cents)}</td><td>{b.pending_count}</td></tr>)}</tbody></table></div></section>}
      <section className="panel"><h2>Detalhamento da apuração</h2><div className="table-wrap"><table><caption>{collector ? 'Recebimentos confirmados para comissões' : 'Vendas para comissões'}</caption><thead><tr><th>{collector ? 'Recebimento' : 'Emissão'}</th><th>Responsável</th><th>Título / cliente</th><th>Filial</th><th>{collector ? 'Vencimento' : 'Centro de custo'}</th><th>{collector ? 'Atraso' : 'Margem calculada'}</th><th>Base</th><th>Taxa</th><th>Comissão</th><th>Situação</th><th>Detalhes</th></tr></thead><tbody>{rows.length ? rows.map(r => <tr key={r.id}><td>{dateLabel(r.date)}</td><td>{r.subject_name || 'Não informado'}</td><td><strong>{r.document}</strong><small>{r.client_name}</small></td><td>{r.branch}</td><td>{collector ? dateLabel(r.due_date!) : r.cost_center}</td><td>{collector ? `${r.delay_days} dias` : percent(r.margin_bps)}</td><td>{formatCents(r.amount_cents)}</td><td>{formatCommissionRate(r)}</td><td>{assessedMoney(r.commission_cents)}</td><td>{commissionEligibility[r.eligibility]}</td><td><button className="button secondary" onClick={() => setSelected(r)}>Abrir {collector ? 'recebimento' : 'venda'} {r.document}</button></td></tr>) : <tr><td colSpan={11} className="empty-state">{collector ? 'Nenhum recebimento trabalhado e validado no filtro.' : 'Nenhum item do fechamento no filtro. Importe a base de Faturamento para consultar.'}</td></tr>}</tbody></table></div>
      <div className="pagination"><p>{view.count} item(ns) · página {page + 1} de {Math.max(1, Math.ceil(view.count / 25))}</p><div className="inline-actions"><button className="button secondary" disabled={page === 0 || loading || busy} onClick={() => { setSelected(null); setPage(v => v - 1); }}>Anterior</button><button className="button secondary" disabled={(page + 1) * 25 >= view.count || loading || busy} onClick={() => { setSelected(null); setPage(v => v + 1); }}>Próxima</button></div></div></section>
      <section className="panel"><h2>Apurações salvas</h2><p className="muted">As posições anteriores guardam os valores, as origens e a regra utilizada, mesmo após novas importações ou mudanças de vigência.</p><div className="table-wrap"><table><caption>Histórico de apurações de comissões</caption><thead><tr><th>Período</th><th>Salva em</th><th>Detalhes</th></tr></thead><tbody>{(report?.assessments ?? []).length ? report!.assessments!.map(a => <tr key={a.id}><td>{dateLabel(a.period_start)} a {dateLabel(a.period_end)}</td><td>{timestamp(a.created_at)}</td><td><button className="button secondary" disabled={busy} onClick={() => openAssessment(a.id)}>Abrir apuração {dateLabel(a.period_start)}</button></td></tr>) : <tr><td colSpan={3}>Nenhuma apuração salva.</td></tr>}</tbody></table></div></section>
      <section className="panel"><details><summary>Histórico de regras e vigências ({view.rule_versions.length})</summary><div className="table-wrap"><table><caption>Versões de regras de comissões</caption><thead><tr><th>Vigência</th><th>Responsável / política</th><th>Registrada em</th><th>Justificativa</th></tr></thead><tbody>{view.rule_versions.map(r => <tr key={r.id}><td>{dateLabel(r.effective_from)}</td><td>{r.kind === 'COLLECTOR' ? `${r.config.eligible_collector_ids?.length ?? 0} cobradora(s) habilitada(s)` : `${r.subject} · ${sellerPolicyLabels[r.config.policy!] ?? ''} · mínimo ${percent(r.config.minimum_margin_bps)}`}</td><td>{timestamp(r.created_at)}</td><td>{r.reason}</td></tr>)}</tbody></table></div></details></section>
    </>}
    {selected && <section className="panel" aria-labelledby="commission-receipt-title"><div className="panel-header"><h2 id="commission-receipt-title">{collector ? 'Recebimento' : 'Venda'} {selected.document}</h2><button className="button secondary" onClick={() => setSelected(null)}>Fechar detalhes</button></div><p>{selected.client_name} · Filial {selected.branch} · {selected.subject_name}</p><dl className="commission-receipt-details">{collector && <><div><dt>Valor nominal</dt><dd>{formatCents(selected.nominal_amount_cents!)}</dd></div><div><dt>Data efetiva do recebimento</dt><dd>{dateLabel(selected.date)}</dd></div><div><dt>Atraso no recebimento</dt><dd>{selected.delay_days} dia(s)</dd></div></>}<div><dt>{collector ? 'Valor efetivamente recebido' : 'Valor da venda'}</dt><dd>{formatCents(selected.amount_cents)}</dd></div><div><dt>Comissão apurada</dt><dd>{assessedMoney(selected.commission_cents)}</dd></div><div><dt>Taxa</dt><dd>{formatCommissionRate(selected)}</dd></div><div><dt>Situação</dt><dd>{commissionEligibility[selected.eligibility]}</dd></div><div><dt>Vigência da regra usada</dt><dd>{selected.rule_effective_from ? dateLabel(selected.rule_effective_from) : 'Pendente'}</dd></div><div><dt>Versão da regra</dt><dd>{selected.rule_id ?? 'Pendente'}</dd></div>{!collector && <><div><dt>CMV</dt><dd>{assessedMoney(selected.cost_cents)}</dd></div><div><dt>Frete</dt><dd>{assessedMoney(selected.freight_cents)}</dd></div><div><dt>Imposto</dt><dd>{assessedMoney(selected.tax_cents)}</dd></div><div><dt>Margem após comissão calculada</dt><dd>{assessedMoney(selected.margin_cents)} · {percent(selected.margin_bps)}</dd></div></>}<div><dt>Revisão da origem</dt><dd>{selected.source_revision}</dd></div></dl></section>}
  </div>;
}
