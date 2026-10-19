import { useState } from 'react';
import { addCivilDays } from '../lib/financial-dates';
import { dateLabel, formatCents } from '../lib/payables';
import { parseMoneyCents } from '../lib/payables-parser.mjs';
import '../payable-import-review.css';

export interface ImportBank { id: string; display_name: string; company?: string; bank?: string }
export interface ReconciliationItem {
  key: string; kind: 'CENT' | 'MISSING' | 'REAPPEARED'; line: number | null; title_id: string | null;
  branch: string; entry_number: string; description: string; due_date: string | null; amount_cents: number | null;
  source_amount_cents?: number; already_written_off?: boolean;
  allowed_actions: string[]; selected_action: string | null; requires_resolution: boolean; problem: string | null;
}
export interface ResolutionDraft { action: '' | 'WRITE_OFF' | 'PAID' | 'REOPEN'; paidOn: string; amount: string; bankId: string }
export type ResolutionChoice = { action: 'WRITE_OFF' | 'REOPEN'; reason: string } | { action: 'PAID'; reason: string; paid_on: string; amount_paid_cents: number; bank_account_id: string };
export const emptyResolution = (): ResolutionDraft => ({ action: '', paidOn: '', amount: '', bankId: '' });
export const payableUuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);
export function validReconciliationItems(items: unknown): items is ReconciliationItem[] {
  return Array.isArray(items) && items.length <= 15000 && new Set(items.map(item => item?.key)).size === items.length && items.every(item => item && typeof item === 'object'
    && typeof item.key === 'string' && /^(row:[1-9]\d{0,3}|title:[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})$/i.test(item.key)
    && ['CENT', 'MISSING', 'REAPPEARED'].includes(item.kind) && (item.line === null || Number.isSafeInteger(item.line) && item.line >= 1 && item.line <= 5000)
    && (item.title_id === null || payableUuid(item.title_id)) && typeof item.branch === 'string' && typeof item.entry_number === 'string' && typeof item.description === 'string'
    && (item.due_date === null || typeof item.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.due_date)) && (item.amount_cents === null || Number.isSafeInteger(item.amount_cents) && item.amount_cents >= 0)
    && Array.isArray(item.allowed_actions) && item.allowed_actions.every((action: unknown) => ['WRITE_OFF', 'PAID', 'REOPEN'].includes(String(action)))
    && (item.selected_action === null || item.allowed_actions.includes(item.selected_action)) && typeof item.requires_resolution === 'boolean' && (item.problem === null || typeof item.problem === 'string')
    && (item.source_amount_cents === undefined || Number.isSafeInteger(item.source_amount_cents) && item.source_amount_cents >= 0)
    && (item.already_written_off === undefined || typeof item.already_written_off === 'boolean')
    && (item.kind === 'CENT' ? item.line !== null && item.key === `row:${item.line}` : item.title_id !== null && item.key === `title:${item.title_id}`)
    && (item.kind !== 'MISSING' || item.line === null)
    && (item.amount_cents !== null && item.due_date !== null || item.allowed_actions.length === 0 && typeof item.problem === 'string' && !!item.problem.trim())
    && (item.kind !== 'CENT' || (item.source_amount_cents === 1 || item.amount_cents === 1) && item.allowed_actions.every((action: string) => action === 'WRITE_OFF')));
}
function validDate(value: string, today: string) { try { return value >= '1900-01-01' && value <= today && addCivilDays(value, 0) === value; } catch { return false; } }
export function resolutionChoices(items: ReconciliationItem[], drafts: Record<string, ResolutionDraft>, banks: ImportBank[], today: string) {
  const choices: Record<string, ResolutionChoice> = {}; let unresolved = 0;
  for (const item of items) {
    const draft = drafts[item.key]; let choice: ResolutionChoice | null = null;
    if (draft?.action && item.allowed_actions.includes(draft.action)) {
      if (draft.action === 'WRITE_OFF') choice = { action: 'WRITE_OFF', reason: item.kind === 'CENT' ? 'Baixa administrativa do título de R$ 0,01 confirmada individualmente nesta importação; não representa pagamento.' : 'Baixa administrativa confirmada nesta importação; não representa pagamento.' };
      else if (draft.action === 'REOPEN') choice = { action: 'REOPEN', reason: 'Reabertura da previsão confirmada nesta importação para o título que reapareceu no relatório.' };
      else if (validDate(draft.paidOn, today) && banks.some(bank => bank.id === draft.bankId)) {
        try { const cents = parseMoneyCents(draft.amount); if (cents > 0) choice = { action: 'PAID', reason: 'Pagamento confirmado nesta importação com data, valor e conta efetivos informados.', paid_on: draft.paidOn, amount_paid_cents: cents, bank_account_id: draft.bankId }; } catch { /* Keep incomplete input for correction. */ }
      }
    }
    if (choice) choices[item.key] = choice;
    else if (item.requires_resolution || item.kind === 'CENT' && !item.already_written_off || !item.allowed_actions.length && !item.already_written_off) unresolved++;
  }
  return { choices, unresolved };
}

export default function PayableImportReconciliation({ items, banks, drafts, disabled, today, onChange }: {
  items: ReconciliationItem[]; banks: ImportBank[]; drafts: Record<string, ResolutionDraft>; disabled: boolean; today: string;
  onChange: (key: string, draft: ResolutionDraft) => void;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / 20)), currentPage = Math.min(page, pages - 1);
  const resolved = resolutionChoices(items, drafts, banks, today);
  if (!items.length) return null;
  return <section className="payable-import-reconciliation stack" aria-label="Conciliação na importação">
    <h3>Conciliação antes de importar</h3>
    <p className="notice">As escolhas serão aplicadas junto com o arquivo, em uma única confirmação. <strong>Somente baixado</strong> retira o título dos valores financeiros e mantém o histórico; não cria pagamento nem realizado.</p>
    <p className="help-text">Confirme cada título de R$ 0,01 separadamente. Para os ausentes de um relatório completo, escolha Pago com os dados efetivos ou Somente baixado. A ausência sozinha não confirma pagamento.</p>
    <p role="status">{items.length} título(s) para conferir · {resolved.unresolved} escolha(s) ainda pendente(s).</p>
    <div className="payable-import-review-items">{items.slice(currentPage * 20, (currentPage + 1) * 20).map(item => {
      const draft = drafts[item.key] ?? emptyResolution();
      return <article className="payable-import-review-item" key={item.key}>
        <div className="payable-import-review-heading"><div><h4>Lançamento {item.entry_number} · Filial {item.branch}</h4><p>{item.description}</p></div><span className="badge">{item.kind === 'CENT' ? 'R$ 0,01' : item.kind === 'MISSING' ? 'Ausente do relatório completo' : 'Reapareceu no relatório'}</span></div>
        <p className="help-text">{item.line ? `Linha ${item.line + 1} · ` : ''}Vencimento {dateLabel(item.due_date)} · Valor nominal {item.amount_cents === null ? 'Não informado' : formatCents(item.amount_cents)}{item.source_amount_cents !== undefined && item.source_amount_cents !== item.amount_cents ? ` · Valor no arquivo ${formatCents(item.source_amount_cents)}` : ''}</p>
        {item.allowed_actions.length === 0 ? <p className={`notice${item.already_written_off ? '' : ' error'}`}>{item.already_written_off ? 'Baixa administrativa já registrada. O título permanece no histórico, fora dos valores financeiros.' : item.problem || 'Confira a previsão original deste título antes de conciliar a importação.'}</p> : item.kind === 'CENT' ? <label className="checkbox-field"><input type="checkbox" aria-label={`Confirmar baixa de R$ 0,01 do lançamento ${item.entry_number} filial ${item.branch}`} checked={draft.action === 'WRITE_OFF'} disabled={disabled} onChange={event => onChange(item.key, { ...emptyResolution(), action: event.target.checked ? 'WRITE_OFF' : '' })} />Confirmo a baixa deste título identificado por R$ 0,01 no arquivo, sem registrar pagamento.</label> : <label className="field">Como conciliar o lançamento {item.entry_number} · Filial {item.branch}<select aria-label={`Conciliação do lançamento ${item.entry_number} filial ${item.branch}`} value={draft.action} disabled={disabled} onChange={event => onChange(item.key, { ...emptyResolution(), action: event.target.value as ResolutionDraft['action'] })}><option value="">Selecione a situação deste título</option>{item.allowed_actions.includes('PAID') && <option value="PAID">Pago — informar pagamento efetivo</option>}{item.allowed_actions.includes('WRITE_OFF') && <option value="WRITE_OFF">Somente baixado — sem pagamento</option>}{item.allowed_actions.includes('REOPEN') && <option value="REOPEN">Reabrir previsão</option>}</select></label>}
        {draft.action === 'PAID' && <div className="payable-import-payment-fields"><label className="field">Data efetiva do pagamento<input aria-label={`Data do pagamento do lançamento ${item.entry_number} filial ${item.branch}`} type="date" min="1900-01-01" max={today} value={draft.paidOn} disabled={disabled} onChange={event => onChange(item.key, { ...draft, paidOn: event.target.value })} /></label><label className="field">Valor efetivamente pago (R$)<input aria-label={`Valor pago do lançamento ${item.entry_number} filial ${item.branch}`} inputMode="decimal" placeholder="0,00" value={draft.amount} maxLength={24} disabled={disabled} onChange={event => onChange(item.key, { ...draft, amount: event.target.value })} /></label><label className="field">Conta que realizou o pagamento<select aria-label={`Banco pago do lançamento ${item.entry_number} filial ${item.branch}`} value={draft.bankId} disabled={disabled} onChange={event => onChange(item.key, { ...draft, bankId: event.target.value })}><option value="">Selecione a conta oficial</option>{banks.map(bank => <option key={bank.id} value={bank.id}>{bank.display_name}</option>)}</select></label></div>}
        {item.problem && <p className="help-text">Última análise: {item.problem}</p>}
      </article>;
    })}</div>
    {pages > 1 && <div className="pagination"><span>Página {currentPage + 1} de {pages}</span><button type="button" className="button secondary" disabled={disabled || currentPage === 0} onClick={() => setPage(currentPage - 1)}>Títulos anteriores da conciliação</button><button type="button" className="button secondary" disabled={disabled || currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>Próximos títulos da conciliação</button></div>}
  </section>;
}
