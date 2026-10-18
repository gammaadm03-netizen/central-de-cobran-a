import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { addCivilDays } from '../lib/financial-dates';
import { dateLabel, formatCents } from '../lib/payables';
import '../collections-management.css';

export interface CollectionSelection { start?: string; end?: string; status?: string; collector?: string; nextAction?: string }
interface Group { title_count: number; amount_cents: number }
interface DelayBand extends Group { key: string; label: string; min_days: number; max_days: number | null }
interface CollectionSummary {
  as_of_date: string; overdue_cents: number; overdue_count: number; client_count: number; average_delay_days: number;
  worked_count: number; no_action_count: number; pending_validation_count: number; pending_validation_cents: number;
  over_180_count: number; returns_today_count: number; returns_overdue_count: number; unassigned_count: number | null; unassigned_cents: number | null;
  by_delay_bands: DelayBand[]; by_status: (Group & { status: string })[];
  by_next_action: (Group & { action: string })[]; by_collector: (Group & { collector_id: string | null; display_name: string })[];
}
const bands = [
  { key: '1_30', label: '1–30 dias', min: 1, max: 30 }, { key: '31_60', label: '31–60 dias', min: 31, max: 60 },
  { key: '61_90', label: '61–90 dias', min: 61, max: 90 }, { key: '91_180', label: '91–180 dias', min: 91, max: 180 },
  { key: '181_365', label: '181–365 dias', min: 181, max: 365 }, { key: 'ACIMA_365', label: 'Acima de 365 dias', min: 366, max: null },
];
const statuses: Record<string, string> = { NEW: 'Novos na carteira', OPEN: 'Em aberto', PENDING_VALIDATION: 'Pagamento informado', NOT_LOCATED: 'Cobrar novamente' };
const nextActions: Record<string, string> = { NONE: 'Sem próxima ação', CONTACT: 'Contato', NO_RESPONSE: 'Sem resposta', PROMISE: 'Promessa de pagamento', RETRY: 'Cobrar novamente', OTHER: 'Outra ação' };
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const totals = ['overdue_cents', 'overdue_count', 'client_count', 'worked_count', 'no_action_count', 'pending_validation_count', 'pending_validation_cents', 'over_180_count', 'returns_today_count', 'returns_overdue_count'] as const;
function validSummary(value: unknown): value is CollectionSummary {
  if (!value || typeof value !== 'object') return false;
  const row = value as CollectionSummary;
  try { if (addCivilDays(row.as_of_date, 0) !== row.as_of_date) return false; } catch { return false; }
  if (totals.some(key => !integer(row[key])) || !Number.isFinite(row.average_delay_days) || row.average_delay_days < 0 || row.average_delay_days > Number.MAX_SAFE_INTEGER) return false;
  if (row.unassigned_count !== null && !integer(row.unassigned_count) || row.unassigned_cents !== null && !integer(row.unassigned_cents)) return false;
  if (!Array.isArray(row.by_delay_bands) || row.by_delay_bands.length !== bands.length || !Array.isArray(row.by_status) || row.by_status.length !== 4 || !Array.isArray(row.by_next_action) || row.by_next_action.length !== 6 || !Array.isArray(row.by_collector)) return false;
  const groups: Group[][] = [row.by_delay_bands, row.by_status, row.by_next_action, row.by_collector];
  if (groups.some(group => group.some(item => !item || !integer(item.amount_cents) || !integer(item.title_count)))) return false;
  if (row.by_delay_bands.some((band, index) => band.key !== bands[index].key || band.min_days !== bands[index].min || band.max_days !== bands[index].max)) return false;
  if (row.by_status.some(item => !Object.hasOwn(statuses, item.status)) || new Set(row.by_status.map(item => item.status)).size !== 4) return false;
  if (row.by_next_action.some(item => !Object.hasOwn(nextActions, item.action)) || new Set(row.by_next_action.map(item => item.action)).size !== 6) return false;
  if (row.by_collector.some(item => (item.collector_id !== null && (typeof item.collector_id !== 'string' || !item.collector_id)) || typeof item.display_name !== 'string' || !item.display_name.trim()) || new Set(row.by_collector.map(item => item.collector_id)).size !== row.by_collector.length) return false;
  if (groups.some(group => group.reduce((sum, item) => sum + BigInt(item.amount_cents), 0n) !== BigInt(row.overdue_cents) || group.reduce((sum, item) => sum + BigInt(item.title_count), 0n) !== BigInt(row.overdue_count))) return false;
  return row.worked_count + row.no_action_count === row.overdue_count && row.client_count <= row.overdue_count && row.pending_validation_count <= row.overdue_count;
}
function errorMessage(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(code)) return 'O resumo gerencial de Cobrança aguarda ativação pela administração. Você pode continuar trabalhando nos títulos abaixo.';
  if (code === '42501') return 'Seu acesso não permite consultar este resumo de cobrança.';
  if (code === 'PGRST301' || code === 'PGRST303') return 'Sua sessão expirou. Entre novamente.';
  if (code === '22003') return 'O consolidado excede o limite de precisão. Solicite a conferência da base à administração.';
  return 'Não foi possível consultar o resumo da cobrança. Atualize para tentar novamente; os títulos permanecem disponíveis abaixo.';
}
const count = (value: number) => value.toLocaleString('pt-BR');

export default function CollectionOverview({ isCollector, collectorId, onDetails, onRefresh, refreshKey = 0 }: { isCollector: boolean; collectorId: string | null; onDetails: (selection: CollectionSelection) => void; onRefresh: () => void; refreshKey?: number }) {
  const [summary, setSummary] = useState<CollectionSummary | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    const client = supabase; if (!client) { setLoading(false); setError('Conexão indisponível.'); return; }
    const abort = new AbortController(); setLoading(true); setError(''); setSummary(null);
    void Promise.resolve(client.rpc('collections_overdue_summary').abortSignal(abort.signal).retry(false)).then(result => {
      if (abort.signal.aborted) return;
      if (result.error) throw result.error;
      if (!validSummary(result.data)) throw new Error('invalid_summary');
      // A RLS é a autorização oficial; esta conferência evita exibir uma resposta
      // incompatível com o escopo de uma cobradora caso a integração esteja incorreta.
      if (isCollector && (result.data.unassigned_count !== null || result.data.unassigned_cents !== null || result.data.by_collector.length > 1 || result.data.by_collector.some(row => row.collector_id !== collectorId))) throw new Error('invalid_scope');
      setSummary(result.data);
    }).catch(failure => { if (!abort.signal.aborted) setError(errorMessage(failure)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [isCollector, collectorId, refreshKey]);
  const coverage = summary?.overdue_count ? summary.worked_count / summary.overdue_count * 100 : 0;
  function openBand(band: typeof bands[number]) {
    if (!summary) return;
    onDetails({ end: addCivilDays(summary.as_of_date, -band.min), ...(band.max !== null ? { start: addCivilDays(summary.as_of_date, -band.max) } : {}) });
  }
  return <section className="collections-management" aria-labelledby="collections-management-title" aria-busy={loading}>
    <div className="panel collections-management-heading"><div className="panel-header"><div><h2 id="collections-management-title">Gestão da cobrança</h2><p className="muted">{isCollector ? 'Sua carteira vencida, contatos e próximos retornos.' : 'Carteira vencida consolidada, responsáveis e acompanhamento da operação.'}</p></div><button type="button" className="button secondary" onClick={onRefresh} disabled={loading}>Atualizar visão da cobrança</button></div>
      {summary && <p className="collections-management-reference">Posição em {dateLabel(summary.as_of_date)} · data oficial de São Paulo · somente títulos vencidos ainda não validados</p>}
      {loading && <p className="help-text">Consultando a carteira vencida…</p>}{error && <p className="notice error" role="alert">{error}</p>}
    </div>
    {summary && <>
      <div className="collections-management-cards">
        <article className="panel collections-management-card collections-management-debt"><h3>Carteira vencida atual</h3><strong>{formatCents(summary.overdue_cents)}</strong><p>Valor nominal dos títulos ainda em cobrança.</p><button className="collections-management-link" type="button" onClick={() => onDetails({})}>Abrir carteira vencida →</button></article>
        <article className="panel collections-management-card"><h3>Títulos vencidos</h3><strong>{count(summary.overdue_count)}</strong><p>{count(summary.client_count)} cliente(s) na carteira vencida.</p><button className="collections-management-link" type="button" onClick={() => onDetails({})}>Consultar títulos →</button></article>
        <article className="panel collections-management-card"><h3>Pagamento informado</h3><strong>{count(summary.pending_validation_count)}</strong><p>{formatCents(summary.pending_validation_cents)} aguardando conferência financeira.</p><button className="collections-management-link" type="button" onClick={() => onDetails({ status: 'PENDING_VALIDATION' })}>Ver títulos em conferência →</button></article>
        <article className="panel collections-management-card"><h3>Retornos para hoje</h3><strong>{count(summary.returns_today_count)}</strong><p>Próxima ação agendada para a data de hoje.</p><span className={summary.returns_overdue_count ? 'collections-management-warning' : 'help-text'}>{count(summary.returns_overdue_count)} retorno(s) com data anterior a hoje</span></article>
      </div>
      <div className="panel collections-management-indicators">
        <div><span>Atraso médio</span><strong>{summary.average_delay_days.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dias</strong><small>Média simples dos títulos ativos vencidos.</small></div>
        <div><span>Cobertura de cobrança</span><strong>{coverage.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</strong><small>{count(summary.worked_count)} título(s) com ação registrada.</small></div>
        <div><span>Sem ação registrada</span><strong>{count(summary.no_action_count)}</strong><small>Contatos e retornos são registrados no detalhe do título.</small></div>
        {!isCollector && summary.unassigned_count !== null && <div><span>Sem cobradora definida</span><strong>{count(summary.unassigned_count)}</strong><button type="button" className="collections-management-link" onClick={() => onDetails({ collector: 'unassigned' })}>Conferir atribuições →</button></div>}
      </div>
      <div className="panel collections-management-bands"><div className="panel-header"><div><h2>Faixas de atraso</h2><p className="muted">Selecione uma faixa para abrir seus títulos. Atraso calculado até {dateLabel(summary.as_of_date)}.</p></div></div><div className="collections-management-band-grid">{summary.by_delay_bands.map((row, index) => <button type="button" key={row.key} className="collections-management-band" onClick={() => openBand(bands[index])} aria-label={`Ver títulos de ${bands[index].label}`}><span>{bands[index].label}</span><strong>{formatCents(row.amount_cents)}</strong><small>{count(row.title_count)} título(s)</small></button>)}</div></div>
      <div className="collections-management-columns">
        <div className="panel collections-management-distribution"><h2>{isCollector ? 'Resumo da sua carteira' : 'Distribuição por cobradora'}</h2><p className="muted">Responsável atribuído na Central. Nenhum vínculo é presumido pelo login.</p><div className="table-wrap"><table className="data-table"><caption className="sr-only">Distribuição da carteira vencida por responsável</caption><thead><tr><th>Responsável</th><th>Títulos</th><th>Valor vencido</th><th><span className="sr-only">Abrir carteira</span></th></tr></thead><tbody>{summary.by_collector.map(row => <tr key={row.collector_id ?? 'unassigned'}><th scope="row">{row.display_name}</th><td>{count(row.title_count)}</td><td>{formatCents(row.amount_cents)}</td><td><button type="button" className="collections-management-link" onClick={() => onDetails(isCollector ? {} : { collector: row.collector_id ?? 'unassigned' })} aria-label={`Abrir carteira de ${row.display_name}`}>Abrir →</button></td></tr>)}{summary.by_collector.length === 0 && <tr><td colSpan={4}>Nenhum título vencido nesta carteira.</td></tr>}</tbody></table></div></div>
        <div className="panel collections-management-attention"><h2>Atenção da cobrança</h2><ul><li><span>Mais de 180 dias de atraso</span><strong>{count(summary.over_180_count)}</strong></li><li><span>Retornos com prazo passado</span><strong>{count(summary.returns_overdue_count)}</strong></li><li><span>Pagamentos a conferir no financeiro</span><strong>{count(summary.pending_validation_count)}</strong></li></ul><p className="help-text">Informar um pagamento preserva o título na carteira até a confirmação financeira. O recebimento confirmado permanece no histórico.</p><button type="button" className="collections-management-link" onClick={() => onDetails({ status: 'NOT_LOCATED' })}>Consultar pagamentos não localizados →</button></div>
      </div>
      <div className="panel collections-management-actions"><h2>Próximas ações da carteira</h2><p className="muted">Organize os contatos pelo encaminhamento registrado em cada título.</p><div className="collections-management-action-grid">{summary.by_next_action.map(row => <button type="button" className="collections-management-action" key={row.action} onClick={() => onDetails({ nextAction: row.action })}><span>{nextActions[row.action]}</span><strong>{count(row.title_count)} título(s)</strong><small>{formatCents(row.amount_cents)}</small></button>)}</div></div>
    </>}
  </section>;
}
